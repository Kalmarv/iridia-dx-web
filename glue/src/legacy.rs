//! The old path, in one place: what the page does not have on the IR yet.
//!
//! DXBC and DXIL lift into naga modules here (`iridia-dxbc`, `iridia-dxil`). For DXBC the IR lift is the program shown
//! and run, and this module gives only the analyses (what reaches each output lane, how a constant buffer holds a
//! matrix) and the specialisation of constant words; for DXIL it gives everything, the `iridia-exec` run of the module
//! included. When the IR has its own analyses and constant folding and DXIL lifts onto
//! it, this module is deleted: `tests/legacy.rs` fails once it is gone, as a reminder to make that test the check that
//! it stays gone.

use iridia::flow::{Flow, Via};
use iridia::{ConstantType, IoType, Program, ResourceId, ResourceKind, Stage};
use serde::Serialize;

use crate::sampling::Textures;
use crate::view::{
    self, Binding, Executed, Io, LaneResult, Lifted, Linked, Pins, Request, Specialised, Wgsl,
};

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

    /// The interface the lift states.
    pub fn interface(&self) -> &iridia::Interface {
        &self.program.interface
    }

    /// The source's target name.
    pub fn target(&self) -> &str {
        &self.program.provenance.target
    }

    /// The lifter and its version.
    pub fn lifter(&self) -> String {
        format!(
            "{} {}",
            self.program.provenance.lifter, self.program.provenance.lifter_version
        )
    }

    /// What the lifter noted.
    pub fn notes(&self) -> &[String] {
        &self.program.notes
    }

    /// The program's stable text: its interface header, then the module.
    pub fn text(&self) -> Result<Lifted, String> {
        Ok(Lifted {
            kind: "legacy",
            text: self.program.text().map_err(|e| e.to_string())?,
            origins: Vec::new(),
        })
    }

    /// The program as WGSL, with its bindings and entry point.
    pub fn wgsl(&self) -> Result<Wgsl, String> {
        wgsl_of(&self.program)
    }

    /// The vertex program as WGSL for the pixel program of interface `consumer`, whose WGSL binds `taken`: through
    /// `iridia::emit::wgsl_for`, the outputs at the consumer's locations and types, the resources after the
    /// consumer's.
    pub fn linked(&self, consumer: &iridia::Interface, taken: &[Binding]) -> Result<Linked, String> {
        let own = wgsl_of(&self.program)?;
        let bindings = own
            .bindings
            .iter()
            .map(|b| {
                (
                    ResourceId(b.resource),
                    (b.group, view::after(taken, b.group, b.binding)),
                )
            })
            .collect();
        let pipeline = iridia::emit::Pipeline {
            bindings,
            feeds: Some(consumer),
            ..Default::default()
        };
        let written = iridia::emit::wgsl_for(&self.program, &pipeline).map_err(|e| e.to_string())?;
        let read = iridia::entry_io(consumer)?;
        let outputs = own
            .outputs
            .into_iter()
            .filter(|o| o.builtin.is_some())
            .chain(
                read.arguments
                    .iter()
                    .filter_map(io_of)
                    .filter(|a| a.location.is_some()),
            )
            .collect();
        Ok(Linked {
            path: "legacy",
            wgsl: Wgsl {
                text: written.text,
                bindings: written
                    .bindings
                    .iter()
                    .map(|(id, (group, binding))| Binding {
                        resource: id.0,
                        group: *group,
                        binding: *binding,
                    })
                    .collect(),
                inputs: own.inputs,
                outputs,
            },
            notes: written.notes,
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

    /// Run the program with `iridia-exec` for `request`: one invocation, or a quad.
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

    /// Whether `iridia-exec` runs the program: it runs pixel and vertex programs.
    pub fn runs(&self) -> bool {
        matches!(self.program.stage, Stage::Pixel | Stage::Vertex)
    }

    /// Whether a run of the program must be a quad's.
    pub fn needs_quad(&self) -> bool {
        iridia_exec::ProgramShader::new(self.program.clone()).is_ok_and(|s| s.needs_quad())
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

/// A naga-path program as WGSL, with each resource's binding from the module's globals.
fn wgsl_of(program: &Program) -> Result<Wgsl, String> {
    let text = iridia::emit::wgsl(program).map_err(|e| e.to_string())?;
    let bindings = program
        .bindings
        .iter()
        .filter_map(|(id, g)| {
            let b = program
                .module
                .global_variables
                .try_get(*g)
                .ok()?
                .binding
                .as_ref()?;
            Some(Binding {
                resource: id.0,
                group: b.group,
                binding: b.binding,
            })
        })
        .collect();
    let io = iridia::entry_io(&program.interface)?;
    let items = |list: &[iridia::IoItem]| -> Vec<Io> { list.iter().filter_map(io_of).collect() };
    Ok(Wgsl {
        text,
        bindings,
        inputs: items(&io.arguments),
        outputs: items(&io.results),
    })
}

fn io_of(item: &iridia::IoItem) -> Option<Io> {
    let IoType::Value(value) = item.ty else {
        return None;
    };
    let (location, builtin, interpolation, sampling) = match &item.binding {
        naga::Binding::BuiltIn(b) => (None, Some(builtin_name(b)), None, None),
        naga::Binding::Location {
            location,
            interpolation,
            sampling,
            ..
        } => (
            Some(*location),
            None,
            interpolation.map(|i| match i {
                naga::Interpolation::Linear => "linear",
                naga::Interpolation::Flat => "flat",
                _ => "perspective",
            }),
            sampling.and_then(|s| match s {
                naga::Sampling::Centroid => Some("centroid"),
                naga::Sampling::Sample => Some("sample"),
                _ => None,
            }),
        ),
    };
    Some(Io {
        name: item.name.clone(),
        varying: *item.varyings.first()?,
        location,
        builtin,
        scalar: value.scalar,
        width: value.width,
        interpolation,
        sampling,
    })
}

fn builtin_name(b: &naga::BuiltIn) -> &'static str {
    match b {
        naga::BuiltIn::Position { .. } => "position",
        naga::BuiltIn::FrontFacing => "front_facing",
        naga::BuiltIn::VertexIndex => "vertex_index",
        naga::BuiltIn::InstanceIndex => "instance_index",
        naga::BuiltIn::SampleIndex => "sample_index",
        naga::BuiltIn::SampleMask => "sample_mask",
        naga::BuiltIn::FragDepth => "frag_depth",
        naga::BuiltIn::PrimitiveIndex => "primitive_index",
        naga::BuiltIn::GlobalInvocationId => "global_invocation_id",
        naga::BuiltIn::LocalInvocationId => "local_invocation_id",
        naga::BuiltIn::LocalInvocationIndex => "local_invocation_index",
        naga::BuiltIn::WorkGroupId => "workgroup_id",
        naga::BuiltIn::NumWorkGroups => "num_workgroups",
        _ => "unknown",
    }
}
