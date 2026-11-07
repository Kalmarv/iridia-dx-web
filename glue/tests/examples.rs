//! The page's examples (`examples/`), each as the page reads it: its listing byte for byte the one Microsoft's tools
//! wrote beside it, its report, and the Direct3D 9 pair linked.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use std::path::{Path, PathBuf};

use iridia_web::Shader;
use iridia_web::container::Format;

fn examples() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples")
}

/// Every compiled example, with its Microsoft listing (`<file>.ms.txt`).
fn compiled() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in std::fs::read_dir(examples()).unwrap() {
        let dir = dir.unwrap().path();
        if !dir.is_dir() {
            continue;
        }
        for file in std::fs::read_dir(&dir).unwrap() {
            let file = file.unwrap().path();
            let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
            if matches!(ext, "dxbc" | "dxil" | "pso" | "vso") {
                out.push(file);
            }
        }
    }
    out.sort();
    out
}

fn open(path: &Path) -> Shader {
    Shader::open(std::fs::read(path).unwrap(), iridia_web::ir::profile(&[]))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn every_example_lists_as_microsofts_tools_list_it() {
    let files = compiled();
    assert_eq!(files.len(), 10, "{files:?}");
    let mut differ = Vec::new();
    for path in &files {
        let report = open(path).report();
        let listing = report
            .bytecode
            .listing
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let reference = std::fs::read_to_string(
            path.with_extension(format!("{}.ms.txt", path.extension().unwrap().to_str().unwrap())),
        )
        .unwrap();
        if listing != reference {
            let line = listing
                .lines()
                .zip(reference.lines())
                .position(|(a, b)| a != b)
                .unwrap_or(listing.lines().count().min(reference.lines().count()));
            differ.push(format!(
                "{}: line {}: dx {:?}, Microsoft {:?}",
                path.display(),
                line + 1,
                listing.lines().nth(line),
                reference.lines().nth(line)
            ));
        }
    }
    assert!(differ.is_empty(), "{}", differ.join("\n"));
}

/// A program iridia refuses is listed all the same, and its report says why.
#[test]
fn a_refused_program_is_listed_and_says_why() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/refused/amplification/amplification.dxil");
    let report = open(&path).report();
    let reference = std::fs::read_to_string(path.with_extension("dxil.ms.txt")).unwrap();
    assert_eq!(report.bytecode.listing.unwrap(), reference);
    let refusal = report.refusal.unwrap();
    assert!(refusal.message.contains("amplification"), "{}", refusal.message);
    assert!(report.wgsl.is_err());
}

#[test]
fn every_example_lifts_to_wgsl() {
    for path in compiled() {
        let report = open(&path).report();
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(report.refusal.is_none(), "{name}: {:?}", report.refusal);
        let wgsl = report.wgsl.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(wgsl.text.contains("fn main"), "{name}: {}", wgsl.text);
        assert!(report.lifted.is_ok(), "{name}");
        // an executor is offered for what it runs: none runs a compute program yet
        let compute = report.interface.as_ref().unwrap().stage == iridia_ir::interface::Stage::Compute;
        assert_eq!(
            report.executors.is_empty(),
            compute,
            "{name}: {:?}",
            report.executors
        );
        // the listing's instructions are tied to their bytes, where the bytecode is a token stream
        if report.format != Format::Dxil {
            let code = report.bytecode.instructions;
            assert!(!code.is_empty(), "{name}: no instruction tied to its bytes");
            assert!(
                code.windows(2).all(|w| w[0].end == w[1].start),
                "{name}: {code:?}"
            );
            assert!(
                code.iter().all(|i| i.start < i.end && i.end <= report.size),
                "{name}: {code:?}"
            );
        }
        // every program is on the IR, a vertex or pixel program run by its interpreter and by iridia-exec compiled
        // from it
        assert_eq!(report.lifted.as_ref().unwrap().kind, "ir", "{name}");
        if !compute {
            assert_eq!(report.executors, ["iridia-exec-ir", "iridia-exec"], "{name}");
        }
        // the IR's lines are tied to the source instructions they came from, where the listing is tied to bytes
        if report.format != Format::Dxil {
            assert!(!report.lifted.unwrap().origins.is_empty(), "{name}");
        }
    }
}

/// Each location the entry point of `wgsl` passes (a vertex program's result members, a pixel program's arguments),
/// with its type, in location order; the module validates.
fn locations(wgsl: &str) -> Vec<(u32, stock_naga::TypeInner)> {
    let module = stock_naga::front::wgsl::parse_str(wgsl).unwrap_or_else(|e| panic!("{e}\n{wgsl}"));
    stock_naga::valid::Validator::new(
        stock_naga::valid::ValidationFlags::all(),
        stock_naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .unwrap_or_else(|e| panic!("{e:?}\n{wgsl}"));
    let entry = &module.entry_points[0];
    let mut out = Vec::new();
    let mut push = |binding: &Option<stock_naga::Binding>, ty: stock_naga::Handle<stock_naga::Type>| {
        if let Some(stock_naga::Binding::Location { location, .. }) = binding {
            out.push((*location, module.types[ty].inner.clone()));
        }
    };
    if entry.stage == stock_naga::ShaderStage::Vertex {
        let result = entry.function.result.as_ref().unwrap();
        let stock_naga::TypeInner::Struct { members, .. } = &module.types[result.ty].inner else {
            panic!("{wgsl}");
        };
        for m in members {
            push(&m.binding, m.ty);
        }
    } else {
        for a in &entry.function.arguments {
            push(&a.binding, a.ty);
        }
    }
    out.sort_by_key(|(l, _)| *l);
    out
}

#[test]
fn the_direct3d_9_pair_links_where_the_pixel_program_reads() {
    let dir = examples().join("d3d9-pair");
    let (vs, ps) = (open(&dir.join("d3d9-pair.vso")), open(&dir.join("d3d9-pair.pso")));
    let shown = ps.report().wgsl.unwrap();
    let linked = vs.linked(&ps).unwrap();
    let read = locations(&shown.text);
    let passed = locations(&linked.wgsl.text);
    assert!(!read.is_empty());
    assert_eq!(
        passed[..read.len()],
        read[..],
        "{}\n{}",
        linked.wgsl.text,
        shown.text
    );
    // one pipeline: no resource of the vertex program where one of the pixel program's is
    for b in &linked.wgsl.bindings {
        assert!(
            !shown
                .bindings
                .iter()
                .any(|c| (c.group, c.binding) == (b.group, b.binding)),
            "{b:?} meets {:?}",
            shown.bindings
        );
        assert!(
            linked
                .wgsl
                .text
                .contains(&format!("@group({}) @binding({})", b.group, b.binding)),
            "{b:?}\n{}",
            linked.wgsl.text
        );
    }
    // the vertex program's unlinked WGSL does not line up with what the pixel program reads: the link is needed
    let alone = locations(&vs.report().wgsl.unwrap().text);
    assert_ne!(alone.get(..read.len()), Some(&read[..]));
}

#[test]
fn a_link_is_a_vertex_program_feeding_a_pixel_program_of_its_generation() {
    let plasma = open(&examples().join("plasma/plasma.dxbc"));
    let dir = examples().join("d3d9-pair");
    let (vs, ps) = (open(&dir.join("d3d9-pair.vso")), open(&dir.join("d3d9-pair.pso")));
    let e = ps.linked(&vs).unwrap_err();
    assert!(e.contains("these are pixel and vertex"), "{e}");
    let e = vs.linked(&plasma).unwrap_err();
    assert!(e.contains("of its own generation"), "{e}");
}

#[test]
fn bytes_that_are_no_shader_are_refused_as_such() {
    let e = Shader::open(
        b"PNG\r\n\x1a\n not a shader".to_vec(),
        iridia_web::ir::profile(&[]),
    )
    .unwrap_err();
    assert!(e.contains("not a compiled Direct3D shader"), "{e}");
    let e = Shader::open(b"DXBC truncated".to_vec(), iridia_web::ir::profile(&[])).unwrap_err();
    assert!(e.contains("DXBC container"), "{e}");
}

#[test]
fn a_constant_that_only_decides_a_branch_reaches_through_control() {
    // lit-brick.hlsl: `if (useNormalMap != 0)` is fxc's `if_nz cb0[2].w` (byte 44) and nothing else reads it; the
    // light direction (bytes 0 to 8) is arithmetic, and the tiling (bytes 56, 60) scales the texture coordinate
    let report = open(&examples().join("lit-brick/lit-brick.dxbc")).report();
    let reach = report.analyses.unwrap().reach.unwrap();
    let red = reach.iter().find(|r| r.output == 0 && r.lane == 0).unwrap();
    let constant = |at: u32| {
        red.sources
            .iter()
            .find(|s| s.kind == "constant" && s.at == at)
            .map(|s| s.via)
    };
    assert_eq!(constant(44), Some("control"));
    assert_eq!(constant(0), Some("value"));
    assert_eq!(constant(56), Some("coordinate"));
}

#[test]
fn the_plasma_colours_default_to_its_palette() {
    // plasma.hlsl states colorA = #d1d5ff and colorB = #68d3ee: fxc keeps them as the constants' defaults, which
    // the page's colour controls, its first frame and the CPU runs all start from
    let report = open(&examples().join("plasma/plasma.dxbc")).report();
    let interface = report.interface.unwrap();
    let layout = interface
        .resources
        .iter()
        .find_map(|r| match &r.kind {
            iridia_ir::interface::ResourceKind::ConstantBuffer { layout } => Some(layout),
            _ => None,
        })
        .unwrap();
    let rgb = |name: &str| -> Vec<u8> {
        let c = layout.constants.iter().find(|c| c.name == name).unwrap();
        let bytes = c
            .default
            .as_ref()
            .unwrap_or_else(|| panic!("{name} has no default"));
        let (words, _) = bytes.as_chunks::<4>();
        words
            .iter()
            .take(3)
            .map(|w| (f32::from_le_bytes(*w) * 255.0).round() as u8)
            .collect()
    };
    assert_eq!(rgb("colorA"), [0xd1, 0xd5, 0xff]);
    assert_eq!(rgb("colorB"), [0x68, 0xd3, 0xee]);
}

/// The CPU executors on each example on the IR, on a quad of inputs spread over [-1, 1] with the constants' defaults (0.5
/// where a word has none) and a
/// gradient in each texture slot: `iridia-exec-ir` (the IR's interpreter), `iridia-exec` (compiled from the IR) and,
/// for DXBC and DXIL, `iridia-exec` on the old naga-module lift give the same bits (any NaN for a NaN), and the outputs
/// vary by lane, so that agreement is not that of constant results.
#[test]
fn the_cpu_executors_agree_on_every_example_on_the_ir() {
    let mut checked = 0;
    for path in compiled() {
        let name = path.file_name().unwrap().to_str().unwrap().to_owned();
        let bytes = std::fs::read(&path).unwrap();
        let mut shader = open(&path);
        let report = shader.report();
        // a compute program (julia) has no CPU run on the page: its GPU run is checked by scripts/variants.mjs
        if report.executors.is_empty() {
            continue;
        }
        let interface = report.interface.as_ref().unwrap();
        let quad = report.needs_quad || interface.stage == iridia_ir::interface::Stage::Pixel;
        let lanes: Vec<serde_json::Value> = (0..if quad { 4 } else { 1 })
            .map(|l| {
                let inputs: Vec<[u32; 4]> = (0..interface.inputs.len())
                    .map(|k| {
                        std::array::from_fn(|c| {
                            (((l * 37 + k * 11 + c * 7) % 19) as f32 / 9.0 - 1.0).to_bits()
                        })
                    })
                    .collect();
                serde_json::json!({ "inputs": inputs })
            })
            .collect();
        let buffers: Vec<(u32, Vec<u32>)> = interface
            .resources
            .iter()
            .filter_map(|r| match &r.kind {
                iridia_ir::interface::ResourceKind::ConstantBuffer { layout } => {
                    let mut words = vec![0.5f32.to_bits(); layout.size.div_ceil(4) as usize];
                    for c in &layout.constants {
                        for (i, w) in c.default.iter().flat_map(|d| d.as_chunks::<4>().0).enumerate() {
                            if let Some(slot) = words.get_mut(c.offset as usize / 4 + i) {
                                *slot = u32::from_le_bytes(*w);
                            }
                        }
                    }
                    Some((r.id.0, words))
                }
                _ => None,
            })
            .collect();
        let request: iridia_web::view::Request =
            serde_json::from_value(serde_json::json!({ "lanes": lanes, "buffers": buffers })).unwrap();
        let gradient: Vec<u8> = (0..16u8)
            .flat_map(|i| [i * 16, 255 - i * 16, i * 8, 255])
            .collect();
        let mut textures = iridia_web::sampling::Textures::default();
        for register in 0..4 {
            shader.set_texture(register, 4, 4, gradient.clone(), false);
            textures.set(
                register,
                iridia_web::sampling::Image {
                    width: 4,
                    height: 4,
                    texels: gradient.clone(),
                    signed: false,
                },
            );
        }
        let mut runs = shader.executions(&request);
        let old = match report.format {
            Format::Dxbc => Some(iridia_web::legacy::NagaProgram::dxbc(&bytes)),
            Format::Dxil => Some(iridia_web::legacy::NagaProgram::dxil(&bytes)),
            Format::D3d9 => None,
        };
        if let Some(old) = old {
            runs.push(old.unwrap().execute(&request, &textures));
        }
        let results: Vec<(String, Vec<iridia_web::view::LaneResult>)> = runs
            .into_iter()
            .map(|r| {
                (
                    r.executor.to_owned(),
                    r.lanes.unwrap_or_else(|e| panic!("{name}: {}: {e}", r.executor)),
                )
            })
            .collect();
        assert_eq!(
            results.len(),
            if report.format == Format::D3d9 { 2 } else { 3 },
            "{name}"
        );
        let words = |lanes: &[iridia_web::view::LaneResult]| -> Vec<Option<[u32; 4]>> {
            lanes.iter().flat_map(|l| l.outputs.iter().copied()).collect()
        };
        let nan = |w: u32| f32::from_bits(w).is_nan();
        let (first, reference) = (&results[0].0, words(&results[0].1));
        for (executor, lanes) in &results[1..] {
            let these = words(lanes);
            assert_eq!(these.len(), reference.len(), "{name}: {executor}");
            for (a, b) in reference.iter().zip(&these) {
                let same = match (a, b) {
                    (Some(a), Some(b)) => a.iter().zip(b).all(|(x, y)| x == y || (nan(*x) && nan(*y))),
                    (None, None) => true,
                    _ => false,
                };
                assert!(
                    same,
                    "{name}: {first} gives {a:?}, {executor} {b:?}\n{first}: {reference:?}\n{executor}: {these:?}\noutputs: {:?}",
                    interface
                        .outputs
                        .iter()
                        .map(|o| (o.label.name.clone(), o.label.index, o.provenance.d3d))
                        .collect::<Vec<_>>()
                );
            }
        }
        if quad {
            let lane = |l: usize| results[0].1[l].outputs.clone();
            assert!(
                (1..4).any(|l| lane(l) != lane(0)),
                "{name}: every lane gives the same outputs"
            );
        }
        checked += 1;
    }
    // plasma, lit-brick, bloom, the pair's two programs, toon, water
    assert_eq!(checked, 9);
}
