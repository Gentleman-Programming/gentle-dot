//! Screenshot encoding: ScreenCaptureKit hands back BGRA rows; the model gets a JPEG.

pub const JPEG_QUALITY: u8 = 65;

/// Encodes a BGRA bitmap whose rows are `bytes_per_row` long (rows may be padded) as JPEG.
pub fn bgra_to_jpeg(
    bgra: &[u8],
    width: u32,
    height: u32,
    bytes_per_row: usize,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || bytes_per_row < w * 4 || bgra.len() < bytes_per_row * (h - 1) + w * 4 {
        let size = bgra.len();
        return Err(format!("unexpected bitmap: {width} × {height}, {bytes_per_row} bytes per row, {size} bytes"));
    }
    let mut rgb = Vec::with_capacity(w * h * 3);
    for row in bgra.chunks(bytes_per_row).take(h) {
        for i in (0..w * 4).step_by(4) {
            rgb.extend_from_slice(&[row[i + 2], row[i + 1], row[i]]);
        }
    }
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality)
        .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("cannot encode the screenshot: {e}"))?;
    Ok(jpeg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(jpeg: &[u8]) -> image::RgbImage {
        image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).unwrap().to_rgb8()
    }

    #[test]
    fn bgra_becomes_a_jpeg_of_the_same_size_and_colors() {
        // 8 × 8 pure red in BGRA.
        let bgra: Vec<u8> = [0u8, 0, 255, 255].repeat(64);
        let jpeg = bgra_to_jpeg(&bgra, 8, 8, 32, 90).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        let image = decode(&jpeg);
        assert_eq!(image.dimensions(), (8, 8));
        let [r, g, b] = image.get_pixel(4, 4).0;
        assert!(r > 240 && g < 20 && b < 20, "{r} {g} {b}");
    }

    #[test]
    fn padded_rows_are_skipped() {
        // 8 × 8 blue, each row padded with 16 bytes of white.
        let row: Vec<u8> = [[255u8, 0, 0, 255].repeat(8), vec![255; 16]].concat();
        let jpeg = bgra_to_jpeg(&row.repeat(8), 8, 8, 48, 90).unwrap();
        let [r, g, b] = decode(&jpeg).get_pixel(7, 7).0;
        assert!(b > 240 && r < 20 && g < 20, "{r} {g} {b}");
    }

    /// A 1280 × 800 BGRA mock of an app window: light chrome, a sidebar, rows of 1 px
    /// "text" strokes, and two colored buttons.
    fn ui_like_bgra() -> Vec<u8> {
        let (w, h) = (1280usize, 800usize);
        let mut bgra = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let (r, g, b) = if y < 52 {
                    (236, 236, 236)
                } else if x < 240 {
                    (246, 242, 248)
                } else if (600..640).contains(&y) && ((900..1010).contains(&x) || (1030..1140).contains(&x)) {
                    if x < 1010 { (10, 132, 255) } else { (255, 59, 48) }
                } else {
                    (255, 255, 255)
                };
                // Glyph-like strokes: 9 px tall lines of text every 24 px, broken into "words".
                let line = (y + 12) % 24 < 9 && y > 60 && y < 580;
                let glyph = (x * 7 + y * 3) % 11 < 4 && x % 64 < 52 && x > 20;
                let (r, g, b) = if line && glyph { (30, 30, 30) } else { (r, g, b) };
                let i = (y * w + x) * 4;
                bgra[i..i + 4].copy_from_slice(&[b, g, r, 255]);
            }
        }
        bgra
    }

    /// Mean absolute error per channel between the source and the decoded JPEG.
    fn mean_error(bgra: &[u8], jpeg: &[u8]) -> f64 {
        let decoded = decode(jpeg);
        let total: u64 = decoded
            .pixels()
            .zip(bgra.chunks(4))
            .map(|(p, s)| (0..3).map(|c| u64::from(p.0[c].abs_diff(s[2 - c]))).sum::<u64>())
            .sum();
        total as f64 / (decoded.pixels().len() * 3) as f64
    }

    #[test]
    fn the_screenshot_quality_is_lighter_and_keeps_text_legible() {
        // S24.8(c): quality 80 → JPEG_QUALITY. Sizes are printed for the record (`--nocapture`).
        assert!((60..=70).contains(&JPEG_QUALITY), "{JPEG_QUALITY}");
        let bgra = ui_like_bgra();
        let before = bgra_to_jpeg(&bgra, 1280, 800, 1280 * 4, 80).unwrap();
        let started = std::time::Instant::now();
        let after = bgra_to_jpeg(&bgra, 1280, 800, 1280 * 4, JPEG_QUALITY).unwrap();
        let took = started.elapsed().as_millis();
        let (error_before, error_after) = (mean_error(&bgra, &before), mean_error(&bgra, &after));
        eprintln!(
            "ui-like 1280x800: quality 80 = {} bytes (error {error_before:.2}), quality {JPEG_QUALITY} = {} bytes (error {error_after:.2}), encoded in {took} ms",
            before.len(),
            after.len()
        );
        assert!(after.len() * 100 <= before.len() * 85, "{} vs {}", after.len(), before.len());
        assert!(error_after < 6.0, "{error_after}");
    }

    #[test]
    fn short_or_empty_bitmaps_are_rejected() {
        assert!(bgra_to_jpeg(&[0; 10], 2, 2, 8, 80).is_err());
        assert!(bgra_to_jpeg(&[], 0, 0, 0, 80).is_err());
        assert!(bgra_to_jpeg(&[0; 64], 4, 4, 8, 80).is_err());
    }
}
