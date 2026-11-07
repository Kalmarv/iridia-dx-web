//! iridia's public pipeline on its own IR: read and lift, specialise pipeline state, structurize, promote, simplify
//! and break flags, validate, write WGSL through stock naga, and run on the CPU with `iridia-exec-ir` and, compiled,
//! with `iridia-exec`.
//!
//! Direct3D 9, DXBC and DXIL programs take this path.

use iridia_ir::interface::{Interface, ResourceId, ResourceKind, Stage};

use crate::sampling::Textures;
use crate::view::{
    self, Binding, Executed, Io, LaneResult, Lifted, Linked, Pins, Request, Specialised, Wgsl,
};

/// The optional WebGPU features whose WGSL [`profile`] can allow: the page asks its device for those the adapter has.
pub const FEATURES: [&str; 4] = ["subgroups", "shader-f16", "primitive-index", "clip-distances"];

/// The WGSL the page's device takes: browser WGSL, bound inside WebGPU's default limits, with the capabilities of the
/// optional WebGPU `features` the device has (of [`FEATURES`]).
pub fn profile(features: &[String]) -> iridia_naga::Profile {
    use stock_naga::valid::Capabilities as C;
    let capabilities = features.iter().fold(C::empty(), |c, f| match f.as_str() {
        "subgroups" => c | C::SUBGROUP,
        "shader-f16" => c | C::SHADER_FLOAT16,
        "primitive-index" => c | C::PRIMITIVE_INDEX,
        "clip-distances" => c | C::CLIP_DISTANCES,
        _ => c,
    });
    iridia_naga::Profile::BROWSER.with(capabilities)
}

/// A program lifted into the IR, before any pass, and the profile its WGSL is written for.
#[derive(Debug)]
pub struct IrProgram {
    lifted: iridia_ir::Program,
    code_base: usize,
    profile: iridia_naga::Profile,
}

impl IrProgram {
    /// Lift a Direct3D 9 token stream.
    pub fn d3d9(bytes: &[u8], profile: iridia_naga::Profile) -> Result<IrProgram, iridia_ir::Refusal> {
        Ok(IrProgram {
            lifted: iridia_d3d9_ir::lift(bytes)?,
            code_base: 0,
            profile,
        })
    }

    /// Lift a DXBC container's program; `code_base` is the file byte where its code part's data starts, which the
    /// lift's word offsets count from.
    pub fn dxbc(
        bytes: &[u8],
        code_base: usize,
        profile: iridia_naga::Profile,
    ) -> Result<IrProgram, iridia_ir::Refusal> {
        Ok(IrProgram {
            lifted: iridia_dxbc::ir::lift(bytes)?,
            code_base,
            profile,
        })
    }

    /// Lift a DXIL container's program. Its values' origins are bits of the bitcode, which the listing is not tied to.
    pub fn dxil(bytes: &[u8], profile: iridia_naga::Profile) -> Result<IrProgram, iridia_ir::Refusal> {
        Ok(IrProgram {
            lifted: iridia_dxil::ir::lift(bytes)?,
            code_base: 0,
            profile,
        })
    }

    /// The interface the lift states.
    pub fn interface(&self) -> &Interface {
        &self.lifted.interface
    }

    /// The source's target name (`ps_3_0`).
    pub fn target(&self) -> &str {
        &self.lifted.provenance.target
    }

    /// The lifter and its version.
    pub fn lifter(&self) -> String {
        format!(
            "{} {}",
            self.lifted.provenance.lifter, self.lifted.provenance.lifter_version
        )
    }

    /// What the lifter noted.
    pub fn notes(&self) -> &[String] {
        &self.lifted.notes
    }

    /// The program after the passes, with `state` folded in first.
    pub fn prepared(&self, state: &[(ResourceId, [u64; 4])]) -> Result<iridia_ir::Program, String> {
        let mut p = self.lifted.clone();
        if !state.is_empty() {
            iridia_passes::specialise(&mut p, state).map_err(|e| format!("specialise: {e}"))?;
        }
        // a DXIL lift's body is a control flow graph: structurize gives it WGSL's structured flow (a structured body is
        // left as it is), and break_flags turns its exits into the flags both the WGSL writer and iridia-exec take
        for f in std::iter::once(&mut p.entry).chain(p.patch.as_mut()) {
            iridia_passes::structurize(f).map_err(|e| format!("structurize: {e}"))?;
            iridia_passes::promote(f).map_err(|e| format!("promote: {e}"))?;
            iridia_passes::simplify(f);
            iridia_passes::break_flags(f).map_err(|e| format!("break_flags: {e}"))?;
        }
        if let Err(problems) = iridia_ir::validate(&p) {
            let first = problems.first().map(ToString::to_string).unwrap_or_default();
            return Err(format!("the IR does not validate: {first}"));
        }
        Ok(p)
    }

    /// The text of a prepared program, each line tied to its source instruction.
    pub fn text(&self, p: &iridia_ir::Program) -> Lifted {
        let text = iridia_ir::text::print(&p.entry);
        let origins = view::ir_origins(&text, &p.entry, self.code_base);
        Lifted {
            kind: "ir",
            text,
            origins,
        }
    }

    /// A prepared program as browser WGSL, with its bindings and entry point.
    pub fn wgsl(&self, p: &iridia_ir::Program) -> Result<Wgsl, String> {
        let text = iridia_naga::wgsl(p, &self.profile).map_err(|e| e.0)?;
        let plan = iridia_naga::BindingPlan::for_profile(&p.interface, &self.profile).map_err(|e| e.0)?;
        let io = iridia_naga::entry_io(&p.interface)?;
        Ok(Wgsl {
            text,
            bindings: plan
                .bindings
                .iter()
                .map(|b| Binding {
                    resource: b.resource.0,
                    group: b.group,
                    binding: b.binding,
                })
                .collect(),
            inputs: io.arguments.iter().map(io_of).collect(),
            outputs: io.results.iter().map(io_of).collect(),
        })
    }

    /// A prepared vertex program as browser WGSL for the pixel program of interface `consumer`, whose WGSL binds
    /// `taken`: through `iridia_naga::wgsl_for`, the outputs at the consumer's locations and types, the resources
    /// after the consumer's.
    pub fn linked(
        &self,
        p: &iridia_ir::Program,
        consumer: &Interface,
        taken: &[Binding],
    ) -> Result<Linked, String> {
        let mut plan = iridia_naga::BindingPlan::for_profile(&p.interface, &self.profile).map_err(|e| e.0)?;
        for b in &mut plan.bindings {
            b.binding = view::after(taken, b.group, b.binding);
        }
        let bindings = plan
            .bindings
            .iter()
            .map(|b| Binding {
                resource: b.resource.0,
                group: b.group,
                binding: b.binding,
            })
            .collect();
        let pipeline = iridia_naga::Pipeline {
            plan,
            feeds: Some(consumer),
        };
        let written = iridia_naga::wgsl_for(p, &self.profile, &pipeline).map_err(|e| e.0)?;
        let io = iridia_naga::entry_io(&p.interface)?;
        let read = iridia_naga::entry_io(consumer)?;
        let outputs = io
            .results
            .iter()
            .filter(|r| matches!(r.binding, stock_naga::Binding::BuiltIn(_)))
            .chain(
                read.arguments
                    .iter()
                    .filter(|a| matches!(a.binding, stock_naga::Binding::Location { .. })),
            )
            .map(io_of)
            .collect();
        Ok(Linked {
            wgsl: Wgsl {
                text: written.text,
                bindings,
                inputs: io.arguments.iter().map(io_of).collect(),
                outputs,
            },
            notes: written.notes,
        })
    }

    /// The program with `pins`' pipeline state folded in, beside the program with `unpinned`'s (the state the page
    /// shows by default). Constant words are not the IR pass's to fold.
    pub fn specialise(&self, pins: &Pins, unpinned: &Pins) -> Result<Specialised, String> {
        let p = self.prepared(&pins.known_state())?;
        let before = self.prepared(&unpinned.known_state())?;
        let ignored = match pins.words.is_empty() {
            true => Vec::new(),
            false => vec![format!(
                "{} constant word{}: iridia-passes specialises pipeline state only",
                pins.words.len(),
                if pins.words.len() == 1 { "" } else { "s" }
            )],
        };
        Ok(Specialised {
            by: "pipeline state",
            before: self.text(&before),
            wgsl_before: self.wgsl(&before).map(|w| w.text),
            lifted: self.text(&p),
            wgsl: self.wgsl(&p).map(|w| w.text),
            folded: None,
            unread: Vec::new(),
            ignored,
        })
    }

    /// The CPU executors that run the program with `state` folded: `iridia-exec-ir`, and `iridia-exec` where it
    /// compiles the program, for a pixel or vertex program; none for any other stage.
    pub fn executors(&self, state: &[(ResourceId, [u64; 4])]) -> Vec<&'static str> {
        // the page's CPU run is one pixel or vertex invocation's inputs and outputs: a compute, mesh or
        // amplification program has none (it reads and writes memory a thread group shares), nor do the other stages
        if !matches!(self.interface().stage, Stage::Pixel | Stage::Vertex) {
            return Vec::new();
        }
        let mut out = vec!["iridia-exec-ir"];
        if self.prepared(state).is_ok_and(|p| self.compiled(&p).is_ok()) {
            out.push("iridia-exec");
        }
        out
    }

    /// Run the prepared program (`state` folded) for `request` on each executor, a quad where the program takes
    /// derivatives.
    pub fn execute(&self, request: &Request, textures: &Textures) -> Vec<Executed> {
        let known: Vec<(ResourceId, [u64; 4])> = request
            .state
            .iter()
            .map(|(r, lanes)| (ResourceId(*r), lanes.map(u64::from)))
            .collect();
        self.executors(&known)
            .into_iter()
            .map(|executor| match executor {
                "iridia-exec-ir" => Executed {
                    executor,
                    runs: "the IR program, interpreted",
                    lanes: self.run(request, textures),
                },
                _ => Executed {
                    executor,
                    runs: "the IR program, compiled",
                    lanes: self.run_compiled(request, textures),
                },
            })
            .collect()
    }

    /// A prepared program compiled by `iridia-exec`.
    fn compiled(&self, p: &iridia_ir::Program) -> Result<iridia_exec::ProgramShader, String> {
        iridia_exec::ProgramShader::from_ir(p.clone()).map_err(|e| e.to_string())
    }

    fn run_compiled(&self, request: &Request, textures: &Textures) -> Result<Vec<LaneResult>, String> {
        let known: Vec<(ResourceId, [u64; 4])> = request
            .state
            .iter()
            .map(|(r, lanes)| (ResourceId(*r), lanes.map(u64::from)))
            .collect();
        let p = self.prepared(&known)?;
        let shader = self.compiled(&p)?;
        crate::exec::run(&shader, &p.interface, p.stage, request, textures)
    }

    fn run(&self, request: &Request, textures: &Textures) -> Result<Vec<LaneResult>, String> {
        let state: Vec<(ResourceId, [u32; 4])> = request
            .state
            .iter()
            .map(|(r, lanes)| (ResourceId(*r), *lanes))
            .collect();
        // the state is folded, as the WGSL the GPU runs has it; the run is bound it too, for any read left
        let known: Vec<(ResourceId, [u64; 4])> = state.iter().map(|(r, l)| (*r, l.map(u64::from))).collect();
        let p = self.prepared(&known)?;
        let rows: Vec<(ResourceId, Vec<[u32; 4]>)> = request
            .buffers
            .iter()
            .map(|(r, words)| (ResourceId(*r), view::rows(words)))
            .collect();
        let buffers: Vec<(ResourceId, &[[u32; 4]])> = rows.iter().map(|(r, w)| (*r, w.as_slice())).collect();
        let interface = &p.interface;
        let result = |run: iridia_exec_ir::Run| LaneResult {
            outputs: run.outputs,
            killed: run.killed,
        };
        let inputs: Vec<&[[u32; 4]]> = request.lanes.iter().map(|l| l.inputs.as_slice()).collect();
        match inputs.as_slice() {
            [one] => {
                let mut sampler = |s| sample_for(interface, textures, s);
                let mut bound = iridia_exec_ir::Bound {
                    inputs: one,
                    buffers: &buffers,
                    state: &state,
                    sampler: &mut sampler,
                    denormals: iridia_ir::Denormals::Any,
                };
                Ok(vec![result(iridia_exec_ir::run(&p, &mut bound)?)])
            }
            [a, b, c, d] => {
                // each lane's sampler answers from the same images; the closures are separate borrows
                let (mut s0, mut s1, mut s2, mut s3) = (
                    |s| sample_for(interface, textures, s),
                    |s| sample_for(interface, textures, s),
                    |s| sample_for(interface, textures, s),
                    |s| sample_for(interface, textures, s),
                );
                let bound = |inputs, sampler| iridia_exec_ir::Bound {
                    inputs,
                    buffers: &buffers,
                    state: &state,
                    sampler,
                    denormals: iridia_ir::Denormals::Any,
                };
                let (mut b0, mut b1, mut b2, mut b3) = (
                    bound(a, &mut s0),
                    bound(b, &mut s1),
                    bound(c, &mut s2),
                    bound(d, &mut s3),
                );
                let runs = iridia_exec_ir::run_quad(&p, [&mut b0, &mut b1, &mut b2, &mut b3])?;
                Ok(runs.into_iter().map(result).collect())
            }
            _ => Err(format!(
                "a run takes one invocation or a quad of four, not {}",
                inputs.len()
            )),
        }
    }

    /// Whether the program takes screen derivatives, so that a run of it is a quad's.
    pub fn needs_quad(&self) -> bool {
        self.prepared(&[]).is_ok_and(|p| iridia_exec_ir::needs_quad(&p))
            || iridia_exec_ir::needs_quad(&self.lifted)
    }

    /// The pipeline state resources the program reads.
    pub fn state(&self) -> Vec<u32> {
        self.lifted
            .interface
            .resources
            .iter()
            .filter(|r| matches!(r.kind, ResourceKind::PipelineState(_)))
            .map(|r| r.id.0)
            .collect()
    }
}

fn sample_for(
    interface: &Interface,
    textures: &Textures,
    s: iridia_exec_ir::Sample,
) -> Result<[f32; 4], String> {
    if s.lanes != 2 {
        return Err(format!(
            "the page's CPU sampler reads 2D textures only; this sample has a {}-lane coordinate",
            s.lanes
        ));
    }
    let register = interface
        .resource(s.texture)
        .and_then(|r| r.provenance.d3d)
        .map(|d| d.register)
        .ok_or_else(|| format!("texture resource {} has no register", s.texture.0))?;
    textures.sample(register, [s.coord[0], s.coord[1]])
}

fn io_of(item: &iridia_naga::Item) -> Io {
    let (location, builtin, interpolation, sampling) = match &item.binding {
        stock_naga::Binding::BuiltIn(b) => (None, Some(builtin_name(b)), None, None),
        stock_naga::Binding::Location {
            location,
            interpolation,
            sampling,
            ..
        } => (
            Some(*location),
            None,
            interpolation.map(|i| match i {
                stock_naga::Interpolation::Perspective => "perspective",
                stock_naga::Interpolation::Linear => "linear",
                stock_naga::Interpolation::Flat => "flat",
                _ => "perspective",
            }),
            sampling.and_then(|s| match s {
                stock_naga::Sampling::Centroid => Some("centroid"),
                stock_naga::Sampling::Sample => Some("sample"),
                _ => None,
            }),
        ),
    };
    Io {
        name: item.name.clone(),
        varying: item.varying,
        location,
        builtin,
        scalar: item.value.scalar,
        width: item.value.width,
        interpolation,
        sampling,
    }
}

fn builtin_name(b: &stock_naga::BuiltIn) -> &'static str {
    match b {
        stock_naga::BuiltIn::Position { .. } => "position",
        stock_naga::BuiltIn::FrontFacing => "front_facing",
        stock_naga::BuiltIn::VertexIndex => "vertex_index",
        stock_naga::BuiltIn::InstanceIndex => "instance_index",
        stock_naga::BuiltIn::SampleIndex => "sample_index",
        stock_naga::BuiltIn::SampleMask => "sample_mask",
        stock_naga::BuiltIn::FragDepth => "frag_depth",
        stock_naga::BuiltIn::PrimitiveIndex => "primitive_index",
        _ => "unknown",
    }
}
