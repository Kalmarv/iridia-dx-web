//! The page's textures on the CPU, sampled as the preview's WebGPU sampler does: one level, bilinear, repeating; an
//! image is `rgba8unorm` or `rgba8snorm` as the GPU's texture is.
//!
//! The executors leave sampling to their caller; this answers them with the same images the GPU draws with. A GPU's
//! filter weights are fixed-point (8 fractional bits on most hardware), so a filtered texel can differ from this one
//! in the last bits: the page says so beside a comparison.

use std::collections::BTreeMap;

/// One RGBA8 image.
#[derive(Clone, Debug)]
pub struct Image {
    /// Width in texels.
    pub width: u32,
    /// Height in texels.
    pub height: u32,
    /// Rows top to bottom, four bytes a texel.
    pub texels: Vec<u8>,
    /// Whether each byte is a signed normalised lane (`rgba8snorm`: -127 and -128 are -1, 127 is 1), as a Direct3D 9
    /// bump map's (V8U8); otherwise unsigned (`rgba8unorm`).
    pub signed: bool,
}

impl Image {
    fn texel(&self, x: i64, y: i64) -> [f32; 4] {
        let w = i64::from(self.width.max(1));
        let h = i64::from(self.height.max(1));
        let (x, y) = (x.rem_euclid(w), y.rem_euclid(h));
        let at = usize::try_from((y * w + x) * 4).unwrap_or(0);
        let mut out = [0.0f32; 4];
        for (lane, o) in out.iter_mut().enumerate() {
            let byte = self.texels.get(at + lane).copied().unwrap_or(0);
            *o = match self.signed {
                true => (f32::from(i8::from_ne_bytes([byte])) / 127.0).max(-1.0),
                false => f32::from(byte) / 255.0,
            };
        }
        out
    }

    /// The bilinear sample at `uv` (0 to 1 across the image, repeating), texel centres at half-texels.
    pub fn sample(&self, uv: [f32; 2]) -> [f32; 4] {
        if !uv[0].is_finite() || !uv[1].is_finite() {
            return [0.0; 4];
        }
        let x = f64::from(uv[0]) * f64::from(self.width) - 0.5;
        let y = f64::from(uv[1]) * f64::from(self.height) - 0.5;
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        #[allow(clippy::cast_possible_truncation)]
        // the coordinates are finite and repeat, so any whole number works
        let (x0, y0) = (x0 as i64, y0 as i64);
        let a = self.texel(x0, y0);
        let b = self.texel(x0 + 1, y0);
        let c = self.texel(x0, y0 + 1);
        let d = self.texel(x0 + 1, y0 + 1);
        let mut out = [0.0f32; 4];
        for lane in 0..4 {
            let top = f64::from(a[lane]) * (1.0 - fx) + f64::from(b[lane]) * fx;
            let bottom = f64::from(c[lane]) * (1.0 - fx) + f64::from(d[lane]) * fx;
            #[allow(clippy::cast_possible_truncation)] // a value between two texels' f32 values
            {
                out[lane] = (top * (1.0 - fy) + bottom * fy) as f32;
            }
        }
        out
    }
}

/// The page's textures by the shader resource register (`t<n>`) of the texture each is bound to.
#[derive(Clone, Debug, Default)]
pub struct Textures {
    images: BTreeMap<u32, Image>,
}

impl Textures {
    /// Bind `image` at register `register`.
    pub fn set(&mut self, register: u32, image: Image) {
        self.images.insert(register, image);
    }

    /// The 2D sample of the texture at `register`, or why there is none.
    pub fn sample(&self, register: u32, uv: [f32; 2]) -> Result<[f32; 4], String> {
        self.images
            .get(&register)
            .map(|i| i.sample(uv))
            .ok_or_else(|| format!("no texture is bound at t{register}"))
    }
}

#[cfg(test)]
mod tests {
    use super::Image;

    fn two_by_one(signed: bool) -> Image {
        // texel 0: 0x00, 0x7f, 0x80, 0xff; texel 1: all 0xff
        Image {
            width: 2,
            height: 1,
            texels: vec![0x00, 0x7f, 0x80, 0xff, 0xff, 0xff, 0xff, 0xff],
            signed,
        }
    }

    #[test]
    fn a_texel_centre_reads_its_texel_as_unorm_or_snorm() {
        assert_eq!(
            two_by_one(false).sample([0.25, 0.5]),
            [0.0, 127.0 / 255.0, 128.0 / 255.0, 1.0]
        );
        // snorm: 0x7f is 1, 0x80 (-128) clamps to -1 as WebGPU's rgba8snorm, 0xff is -1/127
        assert_eq!(
            two_by_one(true).sample([0.25, 0.5]),
            [0.0, 1.0, -1.0, -1.0 / 127.0]
        );
    }

    #[test]
    fn between_texels_is_bilinear_and_the_edge_repeats() {
        let image = two_by_one(false);
        // half way between the centres of texel 0 and texel 1
        assert_eq!(image.sample([0.5, 0.5])[0], 0.5);
        // the left edge is half way between texel 0 and texel 1 repeated from the right
        assert_eq!(image.sample([0.0, 0.5])[0], 0.5);
    }
}
