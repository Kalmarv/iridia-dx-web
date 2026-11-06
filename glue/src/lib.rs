//! The wasm glue of iridia's web demo: what the page asks of a dropped shader, answered with iridia's and dx's
//! public crates and handed back as JSON.
//!
//! A [`Shader`] holds the file's bytes and its lifts. Direct3D 9 programs take iridia's IR pipeline ([`ir`]); DXBC and
//! DXIL take the naga-module crates until their readers lift into the IR ([`legacy`], which also gives the analyses,
//! the constant-word specialisation and the `iridia-exec` runs the IR does not have yet). The bytes, listing and
//! regions come from dx ([`container`]).
#![deny(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod container;
pub mod ir;
pub mod legacy;
pub mod sampling;
pub mod view;

use iridia_ir::interface::{Interface, ResourceKind, Stage, StateParam};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::container::{Bytecode, Format};
use crate::ir::IrProgram;
use crate::legacy::{Analyses, NagaProgram};
use crate::sampling::{Image, Textures};
use crate::view::{Executed, Lifted, Linked, Pins, Request, Specialised, Wgsl};

/// A lift's refusal, with the file byte it names where its unit is one.
#[derive(Clone, Debug, Serialize)]
pub struct Refused {
    /// The refusal as iridia words it.
    pub message: String,
    /// The byte it names in the file.
    pub byte: Option<usize>,
}

/// One piece of pipeline state the program reads, and Direct3D 9's default for it.
#[derive(Clone, Debug, Serialize)]
pub struct State {
    /// The resource.
    pub resource: u32,
    /// What it is.
    pub param: StateParam,
    /// Direct3D 9's value when the application sets none (a texture stage's dimension: 2D).
    pub default: [u32; 4],
}

/// Everything the page shows of a file that does not depend on what the page pins.
#[derive(Clone, Debug, Serialize)]
pub struct Report {
    /// The bytecode.
    pub format: Format,
    /// The file's size in bytes.
    pub size: usize,
    /// The source's target name (`ps_5_0`), where a lift or the reader gave it.
    pub target: Option<String>,
    /// The lifter that made the program shown, and its version.
    pub lifter: Option<String>,
    /// Which path lifted it: `ir` or `naga`.
    pub path: &'static str,
    /// Regions, listing and instruction map.
    pub bytecode: Bytecode,
    /// The interface, where the program lifted.
    pub interface: Option<Interface>,
    /// Why it did not lift.
    pub refusal: Option<Refused>,
    /// The lifted program's text, under the default pipeline state.
    pub lifted: Result<Lifted, String>,
    /// Its WGSL, under the default pipeline state.
    pub wgsl: Result<Wgsl, String>,
    /// What the lifter noted.
    pub notes: Vec<String>,
    /// The pipeline state the program reads.
    pub state: Vec<State>,
    /// The analyses, from the naga path; `Err` says why there are none.
    pub analyses: Result<Analyses, String>,
    /// The executors that can run it.
    pub executors: Vec<&'static str>,
    /// Whether a run must be a 2 x 2 quad (the program takes derivatives).
    pub needs_quad: bool,
}

/// What specialising by the page's pins gave, by path.
#[derive(Clone, Debug, Serialize)]
pub struct Specialisations {
    /// The IR's pass (pipeline state), where the program is on the IR.
    pub ir: Option<Result<Specialised, String>>,
    /// The naga path's (constant words), where it lifts there.
    pub naga: Option<Result<Specialised, String>>,
}

/// A dropped or chosen shader file.
#[wasm_bindgen]
#[derive(Debug)]
pub struct Shader {
    bytes: Vec<u8>,
    format: Format,
    ir: Option<Result<IrProgram, iridia_ir::Refusal>>,
    naga: Option<Result<NagaProgram, String>>,
    textures: Textures,
}

/// The file byte a refusal names: a word of a token stream counts from the code's start.
fn refused(r: &iridia_ir::Refusal, code_base: usize) -> Refused {
    let byte = match r.unit {
        iridia_ir::Unit::Word => r.at.checked_mul(4).and_then(|b| b.checked_add(code_base)),
        iridia_ir::Unit::Bit => Some(r.at / 8),
        iridia_ir::Unit::Line => None,
    };
    Refused {
        message: r.to_string(),
        byte,
    }
}

impl Shader {
    /// Read `bytes`: what they are and their lifts. Only bytes that are no compiled Direct3D shader are an error.
    pub fn open(bytes: Vec<u8>) -> Result<Shader, String> {
        let format = Format::of(&bytes)?;
        let (ir, naga) = match format {
            Format::D3d9 => (Some(IrProgram::d3d9(&bytes)), Some(NagaProgram::d3d9(&bytes))),
            Format::Dxbc => (None, Some(NagaProgram::dxbc(&bytes).map_err(|r| r.to_string()))),
            Format::Dxil => (None, Some(NagaProgram::dxil(&bytes).map_err(|r| r.to_string()))),
        };
        Ok(Shader {
            bytes,
            format,
            ir,
            naga,
            textures: Textures::default(),
        })
    }

    /// The pipeline state the program reads, with Direct3D 9's defaults.
    fn state(&self) -> Vec<State> {
        let Some(Ok(ir)) = &self.ir else {
            return Vec::new();
        };
        ir.interface()
            .resources
            .iter()
            .filter_map(|r| match r.kind {
                ResourceKind::PipelineState(param) => Some(State {
                    resource: r.id.0,
                    param,
                    default: match param {
                        StateParam::TextureDim(_) => [2, 0, 0, 0],
                        _ => [0; 4],
                    },
                }),
                _ => None,
            })
            .collect()
    }

    fn default_pins(&self) -> Pins {
        Pins {
            words: Vec::new(),
            state: self.state().iter().map(|s| (s.resource, s.default)).collect(),
        }
    }

    /// The report of the file.
    pub fn report(&self) -> Report {
        let bytecode = container::bytecode(&self.bytes, self.format);
        let code_base = bytecode.code_base;
        let state = self.state();
        let analyses = match &self.naga {
            Some(Ok(n)) => Ok(n.analyses()),
            Some(Err(e)) => Err(match self.format {
                Format::D3d9 => format!(
                    "the analyses read naga modules, and iridia-d3d9 (the naga-path reader of Direct3D 9) did not \
                     lift this program: {e}"
                ),
                _ => e.clone(),
            }),
            None => Err("no naga-path lift".to_owned()),
        };
        let mut executors = Vec::new();
        if matches!(self.ir, Some(Ok(_))) {
            executors.push("iridia-exec-ir");
        }
        if matches!(self.naga, Some(Ok(_))) {
            executors.push("iridia-exec");
        }
        let needs_quad = match (&self.ir, &self.naga) {
            (Some(Ok(ir)), _) => ir.needs_quad(),
            (_, Some(Ok(n))) => n.needs_quad(),
            _ => false,
        };
        match (&self.ir, &self.naga) {
            (Some(ir), _) => {
                let (interface, refusal, lifted, wgsl, notes, target, lifter) = match ir {
                    Ok(p) => {
                        let prepared = p.prepared(&self.default_pins().known_state());
                        let lifted = prepared.as_ref().map(|q| p.text(q)).map_err(Clone::clone);
                        let wgsl = prepared.and_then(|q| p.wgsl(&q));
                        (
                            Some(p.interface().clone()),
                            None,
                            lifted,
                            wgsl,
                            p.notes().to_vec(),
                            Some(p.target().to_owned()),
                            Some(p.lifter()),
                        )
                    }
                    Err(r) => {
                        let refusal = refused(r, code_base);
                        (
                            None,
                            Some(refusal.clone()),
                            Err(refusal.message.clone()),
                            Err(refusal.message),
                            Vec::new(),
                            None,
                            None,
                        )
                    }
                };
                Report {
                    format: self.format,
                    size: self.bytes.len(),
                    target,
                    lifter,
                    path: "ir",
                    bytecode,
                    interface,
                    refusal,
                    lifted,
                    wgsl,
                    notes,
                    state,
                    analyses,
                    executors,
                    needs_quad,
                }
            }
            (None, naga) => {
                let lift = naga.as_ref().map(|n| n.as_ref());
                let refusal = match &lift {
                    Some(Err(message)) => Some(Refused {
                        message: (*message).clone(),
                        byte: None,
                    }),
                    _ => None,
                };
                let (interface, lifted, wgsl, notes, target, lifter) = match lift {
                    Some(Ok(n)) => (
                        Some(n.interface().clone()),
                        n.text(),
                        n.wgsl(),
                        n.notes().to_vec(),
                        Some(n.target().to_owned()),
                        Some(n.lifter()),
                    ),
                    Some(Err(e)) => (None, Err(e.clone()), Err(e.clone()), Vec::new(), None, None),
                    None => (
                        None,
                        Err("no lift".to_owned()),
                        Err("no lift".to_owned()),
                        Vec::new(),
                        None,
                        None,
                    ),
                };
                Report {
                    format: self.format,
                    size: self.bytes.len(),
                    target,
                    lifter,
                    path: "naga",
                    bytecode,
                    interface,
                    refusal,
                    lifted,
                    wgsl,
                    notes,
                    state,
                    analyses,
                    executors,
                    needs_quad,
                }
            }
        }
    }

    /// The program specialised by `pins` on each path that lifts it.
    pub fn specialisations(&self, pins: &Pins) -> Specialisations {
        let ir = match &self.ir {
            Some(Ok(p)) => {
                // the state the page does not pin keeps its default, so the program still has a WGSL form
                let mut full = self.default_pins();
                for (r, lanes) in &pins.state {
                    if let Some(slot) = full.state.iter_mut().find(|(s, _)| s == r) {
                        slot.1 = *lanes;
                    }
                }
                full.words.clone_from(&pins.words);
                Some(p.specialise(&full, &self.default_pins()))
            }
            _ => None,
        };
        let naga = match &self.naga {
            Some(Ok(n)) if !pins.words.is_empty() || self.ir.is_none() => Some(n.specialise(pins)),
            _ => None,
        };
        Specialisations { ir, naga }
    }

    /// This vertex program's WGSL written for `consumer`, the pixel program it feeds, on the path both programs take
    /// (a Direct3D 9 pair on the IR, a DXBC or DXIL pair on the naga path), against the WGSL the consumer's report
    /// shows: its outputs where the consumer reads them, its resources after the consumer's in each bind group.
    pub fn linked(&self, consumer: &Shader) -> Result<Linked, String> {
        let stages = (self.stage(), consumer.stage());
        if !matches!(stages, (Some(Stage::Vertex), Some(Stage::Pixel))) {
            return Err(format!(
                "a link is a vertex program feeding a pixel program; these are {} and {}",
                stage_name(stages.0),
                stage_name(stages.1)
            ));
        }
        match (&self.ir, &consumer.ir, &self.naga, &consumer.naga) {
            (Some(Ok(vs)), Some(Ok(ps)), _, _) => {
                let shown = ps.prepared(&consumer.default_pins().known_state())?;
                let taken = ps.wgsl(&shown)?.bindings;
                let p = vs.prepared(&self.default_pins().known_state())?;
                vs.linked(&p, &shown.interface, &taken)
            }
            (None, None, Some(Ok(vs)), Some(Ok(ps))) => vs.linked(ps.interface(), &ps.wgsl()?.bindings),
            (Some(Err(r)), ..) | (_, Some(Err(r)), ..) => Err(format!("a program of the pair did not lift: {r}")),
            (_, _, Some(Err(e)), _) | (_, _, _, Some(Err(e))) => Err(format!("a program of the pair did not lift: {e}")),
            _ => Err(
                "Direct3D links a vertex program to a pixel program of its own generation: a Direct3D 9 program \
                 feeds a Direct3D 9 program, a Shader Model 4 to 6 program one of those"
                    .to_owned(),
            ),
        }
    }

    /// The stage of the program shown, where it lifted.
    fn stage(&self) -> Option<Stage> {
        match (&self.ir, &self.naga) {
            (Some(Ok(p)), _) => Some(p.interface().stage),
            (_, Some(Ok(n))) => Some(n.interface().stage),
            _ => None,
        }
    }

    /// Run the program on every CPU executor that can.
    pub fn executions(&self, request: &Request) -> Vec<Executed> {
        let mut out = Vec::new();
        if let Some(Ok(p)) = &self.ir {
            let mut request = request.clone();
            // the GPU runs the program with the default state where the page pins none
            for s in self.state() {
                if !request.state.iter().any(|(r, _)| *r == s.resource) {
                    request.state.push((s.resource, s.default));
                }
            }
            out.push(p.execute(&request, &self.textures));
        }
        if let Some(Ok(n)) = &self.naga {
            out.push(n.execute(request, &self.textures));
        }
        out
    }
}

fn stage_name(stage: Option<Stage>) -> String {
    match stage {
        Some(s) => format!("{s:?}").to_lowercase(),
        None => "one that did not lift".to_owned(),
    }
}

fn json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
}

#[wasm_bindgen]
impl Shader {
    /// Read a file's bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>) -> Result<Shader, JsError> {
        Shader::open(bytes).map_err(|e| JsError::new(&e))
    }

    /// The report, as JSON.
    #[wasm_bindgen(js_name = report)]
    pub fn report_json(&self) -> String {
        json(&self.report())
    }

    /// The specialisations for `pins` (JSON: `{"words": [[resource, offset, word]], "state": [[resource, [lanes]]]}`),
    /// as JSON.
    #[wasm_bindgen(js_name = specialise)]
    pub fn specialise_json(&self, pins: &str) -> String {
        match serde_json::from_str::<Pins>(pins) {
            Ok(pins) => json(&self.specialisations(&pins)),
            Err(e) => json(&Err::<(), String>(format!("pins: {e}"))),
        }
    }

    /// The CPU executors' runs for `request` (JSON, [`Request`]), as JSON.
    #[wasm_bindgen(js_name = execute)]
    pub fn execute_json(&self, request: &str) -> String {
        match serde_json::from_str::<Request>(request) {
            Ok(request) => json(&Ok::<_, String>(self.executions(&request))),
            Err(e) => json(&Err::<(), String>(format!("request: {e}"))),
        }
    }

    /// This vertex program's WGSL for `consumer`, the pixel program it feeds ([`Shader::linked`]), as JSON.
    #[wasm_bindgen(js_name = link)]
    pub fn link_json(&self, consumer: &Shader) -> String {
        json(&self.linked(consumer))
    }

    /// Bind an RGBA8 image (`width` by `height`, rows top to bottom; `signed` for `rgba8snorm`) at shader resource
    /// register `register`, for the CPU executors' samples.
    #[wasm_bindgen(js_name = setTexture)]
    pub fn set_texture(&mut self, register: u32, width: u32, height: u32, texels: Vec<u8>, signed: bool) {
        self.textures.set(
            register,
            Image {
                width,
                height,
                texels,
                signed,
            },
        );
    }
}
