//! Screenshot encoding: ScreenCaptureKit hands back BGRA rows; the model gets a JPEG.

pub const JPEG_QUALITY: u8 = 80;

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

    #[test]
    fn short_or_empty_bitmaps_are_rejected() {
        assert!(bgra_to_jpeg(&[0; 10], 2, 2, 8, 80).is_err());
        assert!(bgra_to_jpeg(&[], 0, 0, 0, 80).is_err());
        assert!(bgra_to_jpeg(&[0; 64], 4, 4, 8, 80).is_err());
    }
}
