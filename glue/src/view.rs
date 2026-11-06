//! What the page is given: plain data, serialized as JSON, the same whichever path produced it.

use iridia_ir::interface::{ResourceId, ScalarType};
use serde::{Deserialize, Serialize};

/// A lifted program's text, and the source instruction each line came from where the lift records it.
#[derive(Clone, Debug, Serialize)]
pub struct Lifted {
    /// `ir` for iridia's own IR, `naga` for a naga module (the path readers not yet on the IR take).
    pub kind: &'static str,
    /// The text.
    pub text: String,
    /// Lines (0-based) and the file byte of the source instruction each came from.
    pub origins: Vec<(usize, usize)>,
}

/// One argument or result member of a WGSL entry point.
#[derive(Clone, Debug, Serialize)]
pub struct Io {
    /// The member's name, `<NAME><index>` after the varying's label.
    pub name: String,
    /// The varying it carries, by index into the interface's inputs or outputs.
    pub varying: usize,
    /// Its location, for a plain varying.
    pub location: Option<u32>,
    /// Its built-in, in WGSL's spelling (`position`, `front_facing`).
    pub builtin: Option<&'static str>,
    /// The scalar type carried.
    pub scalar: ScalarType,
    /// The lanes carried.
    pub width: u8,
    /// `perspective`, `linear` or `flat`, where it is interpolated.
    pub interpolation: Option<&'static str>,
    /// `centroid` or `sample`, where stated.
    pub sampling: Option<&'static str>,
}

/// Where the WGSL binds one resource.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Binding {
    /// The interface resource.
    pub resource: u32,
    /// Its bind group.
    pub group: u32,
    /// Its binding in the group.
    pub binding: u32,
}

/// A program as WGSL, with what a pipeline needs to run it.
#[derive(Clone, Debug, Serialize)]
pub struct Wgsl {
    /// The text.
    pub text: String,
    /// Each resource's group and binding.
    pub bindings: Vec<Binding>,
    /// The entry point's arguments.
    pub inputs: Vec<Io>,
    /// The entry point's result members.
    pub outputs: Vec<Io>,
}

/// A vertex program's WGSL written for the pixel program it feeds.
#[derive(Clone, Debug, Serialize)]
pub struct Linked {
    /// The path both programs took: `ir` or `naga`.
    pub path: &'static str,
    /// The vertex program's WGSL: its resources after the pixel program's in each bind group, its outputs where the
    /// pixel program reads them. `outputs` lists the built-ins and what the pixel program reads (an output it does not
    /// read is written after those, and read by nothing).
    pub wgsl: Wgsl,
    /// What the link approximates.
    pub notes: Vec<String>,
}

/// The binding a producer's resource takes in `group` so as not to meet any of `taken` (the consumer's): its own,
/// after the consumer's last in that group.
pub fn after(taken: &[Binding], group: u32, binding: u32) -> u32 {
    taken
        .iter()
        .filter(|b| b.group == group)
        .map(|b| b.binding.saturating_add(1))
        .max()
        .unwrap_or(0)
        .saturating_add(binding)
}

/// Constant words and pipeline state the page pins.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Pins {
    /// Constant buffer words: resource, byte offset, the word.
    #[serde(default)]
    pub words: Vec<(u32, u32, u32)>,
    /// Pipeline state: resource and its lanes.
    #[serde(default)]
    pub state: Vec<(u32, [u32; 4])>,
}

impl Pins {
    /// The state in the form `iridia_passes::specialise` takes.
    pub fn known_state(&self) -> Vec<(ResourceId, [u64; 4])> {
        self.state
            .iter()
            .map(|(r, lanes)| (ResourceId(*r), lanes.map(u64::from)))
            .collect()
    }
}

/// What specialising gave.
#[derive(Clone, Debug, Serialize)]
pub struct Specialised {
    /// What was folded: `pipeline state` (the IR's pass) or `constant words` (the naga path's).
    pub by: &'static str,
    /// The program's text before: what the path shows unpinned.
    pub before: Lifted,
    /// Its WGSL before, or why there is none.
    pub wgsl_before: Result<String, String>,
    /// The program's text after.
    pub lifted: Lifted,
    /// Its WGSL, or why there is none.
    pub wgsl: Result<String, String>,
    /// Expressions replaced with known values, where the pass counts them.
    pub folded: Option<usize>,
    /// Resources no longer read, by name.
    pub unread: Vec<String>,
    /// Pins this path does not fold, and why.
    pub ignored: Vec<String>,
}

/// One invocation's inputs.
#[derive(Clone, Debug, Deserialize)]
pub struct Invocation {
    /// Each interface input's lanes as 32-bit words, by index into the interface's inputs.
    pub inputs: Vec<[u32; 4]>,
}

/// A run the page asks for: one invocation, or a pixel program's 2 x 2 quad (top row first).
#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    /// One or four invocations.
    pub lanes: Vec<Invocation>,
    /// Each constant buffer's words, by resource.
    #[serde(default)]
    pub buffers: Vec<(u32, Vec<u32>)>,
    /// Pipeline state, by resource.
    #[serde(default)]
    pub state: Vec<(u32, [u32; 4])>,
}

/// One executor's result for each lane.
#[derive(Clone, Debug, Serialize)]
pub struct Executed {
    /// The executor (`iridia-exec-ir`).
    pub executor: &'static str,
    /// What it runs (`the IR program`).
    pub runs: &'static str,
    /// Per lane: each interface output's lanes (`None` where it was not written), and whether it was killed.
    pub lanes: Result<Vec<LaneResult>, String>,
}

/// One lane's outputs.
#[derive(Clone, Debug, Serialize)]
pub struct LaneResult {
    /// Each interface output's lanes as words, by index into the interface's outputs.
    pub outputs: Vec<Option<[u32; 4]>>,
    /// Whether the program discarded the pixel.
    pub killed: bool,
}

/// The rows of `words` (a constant buffer's 32-bit words), four lanes each, the last padded with zeros.
pub fn rows(words: &[u32]) -> Vec<[u32; 4]> {
    words
        .chunks(4)
        .map(|c| {
            let mut row = [0u32; 4];
            row.iter_mut().zip(c).for_each(|(r, w)| *r = *w);
            row
        })
        .collect()
}

/// The line origins of an IR text: each line that defines `%n` and the file byte of value `n`'s source instruction.
pub fn ir_origins(text: &str, function: &iridia_ir::Function, code_base: usize) -> Vec<(usize, usize)> {
    text.lines()
        .enumerate()
        .filter_map(|(line, l)| {
            let rest = l.trim_start().strip_prefix('%')?;
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if !rest[digits.len()..].starts_with(':') {
                return None;
            }
            let value = function.values.get(digits.parse::<usize>().ok()?)?;
            let origin = value.origin?;
            let byte = match origin.unit {
                iridia_ir::Unit::Word => usize::try_from(origin.offset).ok()?.checked_mul(4)?,
                iridia_ir::Unit::Bit | iridia_ir::Unit::Line => return None,
            };
            Some((line, code_base.checked_add(byte)?))
        })
        .collect()
}
