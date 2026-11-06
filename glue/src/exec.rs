//! `iridia-exec`'s runs in the bytecode's register view: each interface input placed in its D3D register's lanes,
//! each constant buffer at its bind slot, each output read back from its register. The compiled program is a lift
//! onto the IR ([`iridia_exec::ProgramShader::from_ir`]) or, until `legacy` goes, a naga module.

use iridia::{Interface, ResourceId, Stage};
use iridia_exec::{PixelShader, ProgramShader};
use iridia_ir::interface::SystemValue;

use crate::sampling::Textures;
use crate::view::{self, LaneResult, Request};

/// Run `shader`, a compiled program with `interface` of `stage`, for `request`: one invocation, or a quad of four.
pub fn run(
    shader: &ProgramShader,
    interface: &Interface,
    stage: Stage,
    request: &Request,
    textures: &Textures,
) -> Result<Vec<LaneResult>, String> {
    let registers = |inputs: &[[u32; 4]]| -> Vec<[u32; 4]> {
        let mut out = vec![[0u32; 4]; shader.input_count()];
        for (v, value) in interface.inputs.iter().zip(inputs) {
            let Some(d3d) = v.provenance.d3d else { continue };
            let Some(register) = out.get_mut(d3d.register as usize) else {
                continue;
            };
            let lanes = (0..4u8).filter(|l| d3d.mask >> l & 1 != 0);
            for (k, lane) in lanes.enumerate() {
                if let (Some(slot), Some(word)) = (register.get_mut(usize::from(lane)), value.get(k)) {
                    *slot = *word;
                }
            }
        }
        out
    };
    // constant buffers by bind slot: the D3D register of each resource the request gives
    let rows: Vec<(u32, Vec<[u32; 4]>)> = request
        .buffers
        .iter()
        .filter_map(|(r, words)| {
            let d3d = interface.resource(ResourceId(*r))?.provenance.d3d?;
            Some((d3d.register, view::rows(words)))
        })
        .collect();
    let buffers: Vec<(u32, &[[u32; 4]])> = rows.iter().map(|(s, w)| (*s, w.as_slice())).collect();
    let mut sampler = |s: iridia_exec::Sample| -> Result<[f32; 4], String> {
        if s.layer.is_some() {
            return Err("the page's CPU sampler reads 2D textures only, not arrays".to_owned());
        }
        textures.sample(s.texture, s.uv)
    };
    // a vertex program's clip position comes back beside its registers
    let outputs = |e: &iridia_exec::Execution, position: Option<[u32; 4]>| -> LaneResult {
        let outputs = interface
            .outputs
            .iter()
            .map(|v| {
                if let (Some(SystemValue::ClipPosition), Some(p)) = (v.system, position) {
                    return Some(p);
                }
                let d3d = v.provenance.d3d?;
                let register = e.outputs.get(d3d.register as usize)?;
                let mut value = [0u32; 4];
                let lanes = (0..4u8).filter(|l| d3d.mask >> l & 1 != 0);
                for (slot, lane) in value.iter_mut().zip(lanes) {
                    *slot = register.get(usize::from(lane)).copied().unwrap_or(0);
                }
                Some(value)
            })
            .collect();
        LaneResult {
            outputs,
            killed: e.discarded,
        }
    };
    let inputs: Vec<Vec<[u32; 4]>> = request.lanes.iter().map(|l| registers(&l.inputs)).collect();
    match inputs.as_slice() {
        [one] if stage == Stage::Vertex => {
            let (e, position) = shader
                .execute_vertex(one, &buffers, &mut sampler)
                .map_err(|e| e.to_string())?;
            Ok(vec![outputs(&e, Some(position))])
        }
        [one] => {
            let e = shader
                .execute(one, &buffers, &mut sampler)
                .map_err(|e| e.to_string())?;
            Ok(vec![outputs(&e, None)])
        }
        [a, b, c, d] => {
            let runs = shader
                .execute_quad([a, b, c, d], &buffers, &mut sampler)
                .map_err(|e| e.to_string())?;
            Ok(runs.iter().map(|e| outputs(e, None)).collect())
        }
        _ => Err(format!(
            "a run takes one invocation or a quad of four, not {}",
            inputs.len()
        )),
    }
}
