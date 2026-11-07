//! The old path, in one place: what the page does not have on the IR yet.
//!
//! DXBC and DXIL lift into naga modules here (`iridia-dxbc`, `iridia-dxil`) for what the IR does not give yet: the
//! analyses (what reaches each output lane, how a constant buffer holds a matrix) and the specialisation of constant
//! words. The IR lift is the program shown and run; the module's `iridia-exec` run stays as the tests' reference. When
//! the IR has its own analyses and constant folding, this module is deleted: `tests/legacy.rs` fails once it is gone,
//! as a reminder to make that test the check that it stays gone.

use iridia::flow::{Flow, Via};
use iridia::{ConstantType, Program, ResourceId, ResourceKind};
use serde::Serialize;

use crate::sampling::Textures;
use crate::view::{Executed, LaneResult, Lifted, Pins, Request, Specialised};

/// A program lifted into a naga module.
#[derive(Debug)]
pub struct NagaProgram {
    program: Program,
}

/// One source that may reach an output lane.
#[derive(Clone, Debug, Serialize)]
pub struct Source {
    /// `input`, `texel` or `constant`.
    pub kind: &'static str,
    /// The input (by index into the interface's inputs) or resource it is.
    pub index: u32,
    /// The input's or texel's lane; a constant's byte offset in its buffer.
    pub at: u32,
    /// `value`, `coordinate` or `control`: how it reaches the lane.
    pub via: &'static str,
}

/// What may reach one output lane.
#[derive(Clone, Debug, Serialize)]
pub struct Reach {
    /// The output, by index into the interface's outputs.
    pub output: usize,
    /// The lane.
    pub lane: u8,
    /// Everything that may reach it.
    pub sources: Vec<Source>,
}

/// How a matrix constant's lines are held.
#[derive(Clone, Debug, Serialize)]
pub struct Matrix {
    /// The constant buffer.
    pub resource: u32,
    /// The constant's name.
    pub name: String,
    /// Its byte offset.
    pub offset: u32,
    /// `rows`, `columns`, or why the program does not show which.
    pub lines: iridia_ir::interface::MatrixLines,
}

/// The analyses of a program.
#[derive(Clone, Debug, Serialize)]
pub struct Analyses {
    /// What may reach each output lane, or why the value graph could not be built.
    pub reach: Result<Vec<Reach>, String>,
    /// What may reach a discard.
    pub discard: Vec<Source>,
    /// Each matrix constant's lines.
    pub matrices: Vec<Matrix>,
    /// The constant words the program's results are made of, by buffer, as byte offsets.
    pub constants_read: Vec<(u32, Vec<u32>)>,
}

fn via(v: Via) -> &'static str {
    match v {
        Via::Value => "value",
        Via::Coordinate => "coordinate",
        Via::Control => "control",
    }
}

impl NagaProgram {
    /// Lift a DXBC container.
    pub fn dxbc(bytes: &[u8]) -> Result<NagaProgram, iridia::Refusal> {
        Ok(NagaProgram {
            program: iridia_dxbc::lift(bytes)?,
        })
    }

    /// Lift a DXIL container.
    pub fn dxil(bytes: &[u8]) -> Result<NagaProgram, iridia::Refusal> {
        Ok(NagaProgram {
            program: iridia_dxil::lift(bytes)?,
        })
    }

    /// The program's stable text: its interface header, then the module.
    fn text(&self) -> Result<Lifted, String> {
        Ok(Lifted {
            kind: "legacy",
            text: self.program.text().map_err(|e| e.to_string())?,
            origins: Vec::new(),
        })
    }

    /// The program with `pins`' constant words folded where they decide a branch or a select.
    pub fn specialise(&self, pins: &Pins) -> Result<Specialised, String> {
        let words: iridia::specialise::Words = pins
            .words
            .iter()
            .map(|(r, offset, word)| ((ResourceId(*r), *offset), *word))
            .collect();
        // a program the pass cannot transform keeps its code: the pinned words stay uniforms, read with their values
        let Ok(s) = iridia::specialise::specialise(&self.program, &words) else {
            let text = self.text()?;
            let wgsl = iridia::emit::wgsl(&self.program).map_err(|e| e.to_string());
            return Ok(Specialised {
                by: "constant words",
                before: text.clone(),
                wgsl_before: wgsl.clone(),
                lifted: text,
                wgsl,
                folded: Some(0),
                unread: Vec::new(),
                ignored: vec![format!(
                    "{} stay uniforms, read with the values pinned: this program's code is kept as it is",
                    if words.len() == 1 {
                        "the pinned word".to_owned()
                    } else {
                        format!("the {} pinned words", words.len())
                    }
                )],
            });
        };
        let names = |ids: &[ResourceId]| -> Vec<String> {
            ids.iter()
                .filter_map(|id| s.program.interface.resource(*id))
                .map(|r| r.provenance.name.clone())
                .collect()
        };
        let mut ignored = Vec::new();
        let unused = words.len().saturating_sub(s.words.len());
        if unused > 0 {
            ignored.push(format!(
                "{unused} constant word{} decide no branch or select, so stay uniforms (iridia folds feature \
                 decisions, not data)",
                if unused == 1 { "" } else { "s" }
            ));
        }
        if !pins.state.is_empty() {
            ignored.push("pipeline state: this program reads none".to_owned());
        }
        Ok(Specialised {
            by: "constant words",
            before: self.text()?,
            wgsl_before: iridia::emit::wgsl(&self.program).map_err(|e| e.to_string()),
            lifted: Lifted {
                kind: "legacy",
                text: s.program.text().map_err(|e| e.to_string())?,
                origins: Vec::new(),
            },
            wgsl: iridia::emit::wgsl(&s.program).map_err(|e| e.to_string()),
            folded: Some(s.folded),
            unread: names(&s.unread),
            ignored,
        })
    }

    /// What may reach each output lane, the discard, how each matrix is held, and the constants read.
    pub fn analyses(&self) -> Analyses {
        let p = &self.program;
        let graph = p.graph();
        let reach = graph.as_ref().map_err(Clone::clone).map(|g| {
            let flow = Flow::of_values(&g.values);
            flow.outputs()
                .iter()
                .map(|(&(output, lane), r)| Reach {
                    output,
                    lane,
                    sources: sources_of(r, &p.interface),
                })
                .collect()
        });
        let discard = match &graph {
            Ok(g) => sources_of(Flow::of_values(&g.values).discard_reach(), &p.interface),
            Err(_) => Vec::new(),
        };
        let mut matrices = Vec::new();
        for r in &p.interface.resources {
            let ResourceKind::ConstantBuffer { layout } = &r.kind else {
                continue;
            };
            for c in &layout.constants {
                if !matches!(c.ty, ConstantType::Matrix { .. }) {
                    continue;
                }
                let size = c.ty.size().unwrap_or(64);
                let lines = iridia::matrix::lines_at(
                    graph.as_ref().map_err(String::as_str),
                    &p.interface,
                    r.id,
                    c.offset,
                    size,
                );
                matrices.push(Matrix {
                    resource: r.id.0,
                    name: c.name.clone(),
                    offset: c.offset,
                    lines,
                });
            }
        }
        let constants_read = match &graph {
            Ok(g) => g
                .reads
                .buffers()
                .map(|b| (b.0, g.reads.words(b).map(|w| w.saturating_mul(4)).collect()))
                .collect(),
            Err(_) => Vec::new(),
        };
        Analyses {
            reach,
            discard,
            matrices,
            constants_read,
        }
    }

    /// Run the program with `iridia-exec` for `request`: one invocation, or a quad. The page runs the IR; the tests
    /// compare the IR's runs with this one.
    pub fn execute(&self, request: &Request, textures: &Textures) -> Executed {
        Executed {
            executor: "iridia-exec",
            runs: "the lifted module, in the bytecode's register view",
            lanes: self.run(request, textures),
        }
    }

    fn run(&self, request: &Request, textures: &Textures) -> Result<Vec<LaneResult>, String> {
        let shader = iridia_exec::ProgramShader::new(self.program.clone()).map_err(|e| e.to_string())?;
        crate::exec::run(
            &shader,
            &self.program.interface,
            self.program.stage,
            request,
            textures,
        )
    }
}

/// What reaches an output lane or the discard: input lanes, texel lanes and constant-buffer words (at their byte
/// offset), each with the way it reaches.
fn sources_of(r: &iridia::flow::Reach, interface: &iridia::Interface) -> Vec<Source> {
    let mut sources: Vec<Source> = r
        .inputs
        .iter()
        .map(|(l, v)| Source {
            kind: "input",
            index: u32::try_from(l.input).unwrap_or(u32::MAX),
            at: u32::from(l.lane),
            via: via(*v),
        })
        .collect();
    sources.extend(r.texels.iter().map(|(t, v)| Source {
        kind: "texel",
        index: t.resource.0,
        at: u32::from(t.lane),
        via: via(*v),
    }));
    let constant_buffer = |id: ResourceId| {
        interface
            .resources
            .iter()
            .any(|res| res.id == id && matches!(res.kind, ResourceKind::ConstantBuffer { .. }))
    };
    sources.extend(
        r.words
            .iter()
            .filter(|(w, _)| constant_buffer(w.resource))
            .map(|(w, v)| Source {
                kind: "constant",
                index: w.resource.0,
                at: w.word.saturating_mul(4),
                via: via(*v),
            }),
    );
    sources
}
