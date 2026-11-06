//! What a program file is, the regions of its bytes and its Microsoft listing, with each listed instruction's bytes.
//!
//! The listing is dx's, byte for byte what `D3DDisassemble` or `dxc -dumpbin` writes. Its lines are tied to the bytes
//! they decode by a second listing with `D3D_DISASM_ENABLE_INSTRUCTION_OFFSET`, which prefixes each instruction with
//! its byte offset: where the two listings do not have the same lines, nothing is tied rather than something wrongly.

use serde::Serialize;

/// The bytecode a file holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    /// A `DXBC` container of a Shader Model 4 or 5 program.
    Dxbc,
    /// A `DXBC` container with a `DXIL` part: Shader Model 6.
    Dxil,
    /// A Direct3D 9 token stream, Shader Model 1 to 3.
    D3d9,
}

impl Format {
    /// What `bytes` are, or why they are none of the three.
    pub fn of(bytes: &[u8]) -> Result<Format, String> {
        if bytes.starts_with(b"DXBC") {
            let parts = dxcontainer::chunks(bytes).map_err(|e| format!("the DXBC container: {e}"))?;
            return Ok(match parts.iter().any(|c| &c.kind == b"DXIL") {
                true => Format::Dxil,
                false => Format::Dxbc,
            });
        }
        // a Direct3D 9 version token: 0xfffe (vertex) or 0xffff (pixel) in its high half
        if matches!(bytes.get(2..4), Some([0xfe | 0xff, 0xff])) {
            return Ok(Format::D3d9);
        }
        Err(
            "this is not a compiled Direct3D shader: it starts as neither a DXBC container nor a Direct3D 9 \
             token stream"
                .to_owned(),
        )
    }
}

/// A labelled range of the file's bytes.
#[derive(Clone, Debug, Serialize)]
pub struct Region {
    /// What it is (`RDEF part`, `container header`).
    pub label: String,
    /// The part's four-character tag where it is a part.
    pub tag: Option<String>,
    /// First byte.
    pub start: usize,
    /// One past the last byte.
    pub end: usize,
}

/// One listed instruction and its bytes.
#[derive(Clone, Debug, Serialize)]
pub struct Instruction {
    /// The listing line (0-based) it is written on.
    pub line: usize,
    /// First byte in the file.
    pub start: usize,
    /// One past its last byte.
    pub end: usize,
}

/// The file's regions, listing and instruction map.
#[derive(Clone, Debug, Serialize)]
pub struct Bytecode {
    /// Regions in file order: the container's header and parts, or a token stream's version, comments and code.
    pub regions: Vec<Region>,
    /// The listing, or why dx could not write it.
    pub listing: Result<String, String>,
    /// Each listed instruction's bytes; empty where the listing's lines cannot be tied to bytes (DXIL, whose
    /// instructions are LLVM bitcode records).
    pub instructions: Vec<Instruction>,
    /// Where the instruction offsets the listing states count from: the code part's data, or 0 for a token stream.
    pub code_base: usize,
}

/// The offset of `part` (a sub-slice of `whole`) in `whole`.
fn offset_in(whole: &[u8], part: &[u8]) -> usize {
    (part.as_ptr() as usize).saturating_sub(whole.as_ptr() as usize)
}

fn tag(kind: &[u8; 4]) -> String {
    kind.iter()
        .map(|&b| if b.is_ascii_graphic() { char::from(b) } else { '?' })
        .collect()
}

/// What a part tag holds, in a few words.
fn part_label(tag: &str) -> &'static str {
    match tag {
        "RDEF" => "resource reflection",
        "ISGN" | "ISG1" => "input signature",
        "OSGN" | "OSG1" | "OSG5" => "output signature",
        "PCSG" | "PSG1" => "patch constant signature",
        "SHDR" | "SHEX" => "program tokens",
        "STAT" => "statistics",
        "SFI0" => "feature flags",
        "DXIL" => "DXIL program (LLVM bitcode)",
        "ILDB" => "DXIL program with debug information",
        "ILDN" => "debug name",
        "HASH" => "shader hash",
        "PSV0" => "pipeline state validation",
        "RTS0" => "root signature",
        "RDAT" => "runtime data",
        "SPDB" => "debug information (PDB)",
        "Aon9" => "Direct3D 9 level program",
        "IFCE" => "interfaces",
        "PRIV" => "private data",
        _ => "part",
    }
}

/// The regions, listing and instruction map of `bytes` of format `format`.
pub fn bytecode(bytes: &[u8], format: Format) -> Bytecode {
    match format {
        Format::Dxbc | Format::Dxil => container(bytes, format),
        Format::D3d9 => token_stream(bytes),
    }
}

fn container(bytes: &[u8], format: Format) -> Bytecode {
    let mut regions = Vec::new();
    let mut code_base = 0;
    let parts = dxcontainer::chunks(bytes).unwrap_or_default();
    let directory_end = 32usize.saturating_add(parts.len().saturating_mul(4));
    regions.push(Region {
        label: "container header: magic, digest, version, size, part count".into(),
        tag: None,
        start: 0,
        end: 32.min(bytes.len()),
    });
    regions.push(Region {
        label: "part offsets".into(),
        tag: None,
        start: 32.min(bytes.len()),
        end: directory_end.min(bytes.len()),
    });
    for part in &parts {
        let start = offset_in(bytes, part.data);
        let name = tag(&part.kind);
        if name == "SHDR" || name == "SHEX" {
            code_base = start;
        }
        regions.push(Region {
            label: format!("{name} part header: tag and size"),
            tag: Some(name.clone()),
            start: start.saturating_sub(8),
            end: start,
        });
        regions.push(Region {
            label: format!("{name}: {}", part_label(&name)),
            tag: Some(name),
            start,
            end: start.saturating_add(part.data.len()),
        });
    }
    match format {
        Format::Dxil => {
            let listing = dxil_reader::disasm::disassemble(bytes).map_err(|e| e.to_string());
            Bytecode {
                regions,
                listing,
                instructions: Vec::new(),
                code_base,
            }
        }
        _ => {
            let listing = dxbc_reader::disassemble(bytes).map_err(|e| e.to_string());
            let offsets = dxbc_reader::Options::from_flags(0x20)
                .and_then(|o| dxbc_reader::disassemble_with(bytes, &o))
                .ok();
            let code_end = regions
                .iter()
                .find(|r| r.start == code_base && r.tag.is_some() && !r.label.contains("header"))
                .map_or(bytes.len(), |r| r.end);
            let instructions = match (&listing, &offsets) {
                (Ok(plain), Some(offsets)) => tie(plain, offsets, code_base, code_end),
                _ => Vec::new(),
            };
            Bytecode {
                regions,
                listing,
                instructions,
                code_base,
            }
        }
    }
}

fn token_stream(bytes: &[u8]) -> Bytecode {
    let mut regions = vec![Region {
        label: "version token".into(),
        tag: None,
        start: 0,
        end: 4.min(bytes.len()),
    }];
    // comment blocks (the CTAB constant table among them) follow the version token: 0xfffe in the low half, the
    // block's length in words in bits 16 to 30
    let mut at = 4usize;
    let mut code_start = at;
    while let Some(word) = bytes.get(at..at.saturating_add(4)) {
        let word = u32::from_le_bytes([word[0], word[1], word[2], word[3]]);
        if word & 0xffff != 0xfffe {
            break;
        }
        let words = usize::try_from((word >> 16) & 0x7fff).unwrap_or(0);
        let end = at
            .saturating_add(4)
            .saturating_add(words.saturating_mul(4))
            .min(bytes.len());
        let kind = bytes.get(at.saturating_add(4)..at.saturating_add(8)).map(|k| {
            k.iter()
                .map(|&b| if b.is_ascii_graphic() { char::from(b) } else { '?' })
                .collect::<String>()
        });
        regions.push(Region {
            label: match kind.as_deref() {
                Some("CTAB") => "comment: CTAB constant table".into(),
                Some(k) => format!("comment: {k}"),
                None => "comment".into(),
            },
            tag: kind,
            start: at,
            end,
        });
        at = end;
        code_start = end;
    }
    // the stream ends with the end token, 0x0000ffff
    let end_token = bytes.len() >= code_start.saturating_add(4) && bytes.ends_with(&[0xff, 0xff, 0x00, 0x00]);
    let code_end = if end_token {
        bytes.len().saturating_sub(4)
    } else {
        bytes.len()
    };
    regions.push(Region {
        label: "instruction tokens".into(),
        tag: None,
        start: code_start,
        end: code_end,
    });
    if end_token {
        regions.push(Region {
            label: "end token".into(),
            tag: None,
            start: code_end,
            end: bytes.len(),
        });
    }
    let listing = d3d9_reader::disassemble(bytes).map_err(|e| e.to_string());
    let offsets = d3d9_reader::Options::from_flags(0x20)
        .and_then(|o| d3d9_reader::disassemble_with(bytes, &o))
        .ok();
    let instructions = match (&listing, &offsets) {
        (Ok(plain), Some(offsets)) => tie(plain, offsets, 0, code_end),
        _ => Vec::new(),
    };
    Bytecode {
        regions,
        listing,
        instructions,
        code_base: 0,
    }
}

/// The byte offset an offset listing's line states (`0x000000D8:     def c2, ...`).
fn stated_offset(line: &str) -> Option<usize> {
    let (head, _) = line.split_once(": ")?;
    let hex = head.trim_start().strip_prefix("0x")?;
    if hex.len() != 8 {
        return None;
    }
    usize::from_str_radix(hex, 16).ok()
}

/// Each instruction of `plain` with its bytes, read from the same lines of `offsets`; empty where the two listings
/// do not line up. An instruction runs to the next one's offset, the last to `end`.
fn tie(plain: &str, offsets: &str, base: usize, end: usize) -> Vec<Instruction> {
    let plain: Vec<&str> = plain.lines().collect();
    let offsets: Vec<&str> = offsets.lines().collect();
    if plain.len() != offsets.len() {
        return Vec::new();
    }
    let mut found: Vec<(usize, usize)> = Vec::new();
    for (line, (p, o)) in plain.iter().zip(&offsets).enumerate() {
        let Some(at) = stated_offset(o) else {
            continue;
        };
        // the same instruction: the offset listing's line ends with the plain line's text
        if !o.trim_end().ends_with(p.trim()) {
            return Vec::new();
        }
        found.push((line, base.saturating_add(at)));
    }
    let mut out = Vec::with_capacity(found.len());
    for (i, &(line, start)) in found.iter().enumerate() {
        let next = found.get(i.saturating_add(1)).map_or(end, |&(_, s)| s);
        if next < start {
            return Vec::new();
        }
        out.push(Instruction {
            line,
            start,
            end: next,
        });
    }
    out
}
