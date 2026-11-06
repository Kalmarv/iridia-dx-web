//! Prints the page's report of a program file as JSON: `cargo run --example probe -- shader.dxbc [pins json]`, or
//! with `--link pixel.pso` after a vertex program, the WGSL the pair links to.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args
        .first()
        .ok_or("usage: probe <shader file> [pins json | --link <pixel program>]")?;
    let shader = iridia_web::Shader::open(std::fs::read(path)?)?;
    if let [_, flag, consumer] = args.as_slice()
        && flag == "--link"
    {
        let consumer = iridia_web::Shader::open(std::fs::read(consumer)?)?;
        let linked = shader.linked(&consumer)?;
        for note in &linked.notes {
            eprintln!("note: {note}");
        }
        println!("{}", linked.wgsl.text);
        return Ok(());
    }
    println!("{}", serde_json::to_string_pretty(&shader.report())?);
    if let Some(pins) = args.get(1) {
        let pins: iridia_web::view::Pins = serde_json::from_str(pins)?;
        println!("{}", serde_json::to_string_pretty(&shader.specialised(&pins))?);
    }
    Ok(())
}
