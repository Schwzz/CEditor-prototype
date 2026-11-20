//! Media probing for the Stage 6 media engine.
//!
//! M1 needs duration and display size before a clip can be inserted:
//! `.sourceDuration()` is author-declared, so import writes the probed
//! duration and the renderer never has to guess. Probes read only the
//! container headers, never the whole file:
//!
//! - ISO-BMFF (`mp4`, `mov`, `m4v`) through the pure-Rust `mp4` reader.
//! - WebM through a bounded EBML header scan (Segment > Info/Tracks).
//!
//! Failures are structured strings, never panics. Audio track details are
//! reported when the container exposes them; M1 uses video only.

use serde::Serialize;
use std::io::Read;
use std::path::Path;

/// The authorization ceiling for media assets (streamed, never read whole).
pub const MAX_MEDIA_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// How many leading bytes the WebM EBML scan may read.
const WEBM_HEADER_BYTES: usize = 4 * 1024 * 1024;

pub const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "m4v", "webm"];
pub const AUDIO_EXTENSIONS: [&str; 6] = ["mp3", "wav", "m4a", "aac", "flac", "ogg"];

/// A probed media file, in the shape the renderer caches.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct MediaProbe {
    pub kind: String,
    pub duration: f64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub rotation: Option<f64>,
}

fn extension(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
}

pub fn is_video_path(path: &str) -> bool {
    extension(path)
        .map(|ext| VIDEO_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

pub fn is_audio_path(path: &str) -> bool {
    extension(path)
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// Probes a media file by extension and container. Returns a structured
/// error for missing, oversized, unsupported, or unreadable files.
pub fn probe_media(path: &str) -> Result<MediaProbe, String> {
    let file_path = Path::new(path);
    let metadata = std::fs::metadata(file_path)
        .map_err(|_| "Media file is missing or unreadable.".to_string())?;
    if !metadata.is_file() {
        return Err("Media file is missing or unreadable.".to_string());
    }
    if metadata.len() > MAX_MEDIA_BYTES {
        return Err("Media file exceeds the 4 GiB limit.".to_string());
    }
    let extension = extension(path)
        .ok_or_else(|| "Unsupported media format.".to_string())?;
    if !VIDEO_EXTENSIONS.contains(&extension.as_str())
        && !AUDIO_EXTENSIONS.contains(&extension.as_str())
    {
        return Err(format!("Unsupported media format: .{extension}."));
    }
    if extension == "webm" {
        return probe_webm(file_path);
    }
    if VIDEO_EXTENSIONS.contains(&extension.as_str())
        || extension == "m4a"
        || extension == "aac"
    {
        return probe_mp4(file_path, metadata.len());
    }
    Err(format!(
        "Media probing is not supported yet for .{extension} files."
    ))
}

fn probe_mp4(path: &Path, size: u64) -> Result<MediaProbe, String> {
    use mp4::TrackType;
    let file = std::fs::File::open(path)
        .map_err(|_| "Media file is missing or unreadable.".to_string())?;
    let reader = mp4::Mp4Reader::read_header(file, size)
        .map_err(|error| format!("Unreadable media container: {error}."))?;
    let mut probe = MediaProbe {
        kind: "audio".to_string(),
        duration: reader.duration().as_secs_f64(),
        width: None,
        height: None,
        fps: None,
        video_codec: None,
        audio_codec: None,
        channels: None,
        sample_rate: None,
        rotation: None,
    };
    for track in reader.tracks().values() {
        match track.track_type() {
            Ok(TrackType::Video) if probe.width.is_none() => {
                probe.kind = "video".to_string();
                probe.width = Some(track.width() as u32);
                probe.height = Some(track.height() as u32);
                let fps = track.frame_rate();
                if fps.is_finite() && fps > 0.0 {
                    probe.fps = Some(fps);
                }
                probe.video_codec = track.box_type().ok().map(|codec| format!("{codec:?}"));
            }
            Ok(TrackType::Audio) if probe.audio_codec.is_none() => {
                probe.audio_codec = track.box_type().ok().map(|codec| format!("{codec:?}"));
            }
            _ => {}
        }
    }
    if !probe.duration.is_finite() || probe.duration <= 0.0 {
        // A fragmented file can report zero movie duration; fall back to
        // the longest track duration.
        let track_duration = reader
            .tracks()
            .values()
            .map(|track| track.duration().as_secs_f64())
            .fold(0.0f64, f64::max);
        probe.duration = track_duration;
    }
    if !probe.duration.is_finite() || probe.duration <= 0.0 {
        return Err("Could not read the media duration.".to_string());
    }
    Ok(probe)
}

fn probe_webm(path: &Path) -> Result<MediaProbe, String> {
    let file = std::fs::File::open(path)
        .map_err(|_| "Media file is missing or unreadable.".to_string())?;
    let mut bytes = Vec::new();
    file.take(WEBM_HEADER_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Unreadable media container: {error}."))?;
    let (duration, width, height, fps, video_codec, audio_codec) =
        parse_webm_header(&bytes).ok_or_else(|| "Unreadable media container.".to_string())?;
    Ok(MediaProbe {
        kind: if width.is_some() { "video" } else { "audio" }.to_string(),
        duration,
        width,
        height,
        fps,
        video_codec,
        audio_codec,
        channels: None,
        sample_rate: None,
        rotation: None,
    })
}

#[derive(Debug, Clone, Copy)]
struct Element {
    id: u64,
    start: usize,
    end: usize,
}

/// Reads an EBML element ID (the marker bit is part of the ID value).
fn read_id(bytes: &[u8], pos: usize, end: usize) -> Option<(u64, usize)> {
    let first = *bytes.get(pos)?;
    let mut mask = 0x80u8;
    let mut length = 0usize;
    while length < 4 {
        length += 1;
        if first & mask != 0 {
            break;
        }
        mask >>= 1;
    }
    if length == 0 || pos + length > end {
        return None;
    }
    let mut value = 0u64;
    for byte in &bytes[pos..pos + length] {
        value = (value << 8) | u64::from(*byte);
    }
    Some((value, length))
}

/// Reads an EBML size (the marker bit is not part of the value). The
/// returned flag marks the all-ones "unknown size" form.
fn read_size(bytes: &[u8], pos: usize, end: usize) -> Option<(u64, usize, bool)> {
    let first = *bytes.get(pos)?;
    let mut mask = 0x80u8;
    let mut length = 0usize;
    while length < 8 {
        length += 1;
        if first & mask != 0 {
            break;
        }
        mask >>= 1;
    }
    if length == 0 || pos + length > end {
        return None;
    }
    let mut value = u64::from(first) & (0xFFu64 >> length);
    let mut all_ones = value == (0xFFu64 >> length);
    for byte in &bytes[pos + 1..pos + length] {
        value = (value << 8) | u64::from(*byte);
        all_ones = all_ones && *byte == 0xFF;
    }
    Some((value, length, all_ones))
}

fn elements(bytes: &[u8], start: usize, end: usize) -> Vec<Element> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos < end {
        let Some((id, id_len)) = read_id(bytes, pos, end) else {
            break;
        };
        let Some((size, size_len, unknown)) = read_size(bytes, pos + id_len, end) else {
            break;
        };
        let payload = pos + id_len + size_len;
        let payload_end = if unknown {
            end
        } else {
            payload.saturating_add(size as usize).min(end)
        };
        out.push(Element {
            id,
            start: payload,
            end: payload_end,
        });
        if payload_end <= pos {
            break;
        }
        pos = payload_end;
    }
    out
}

fn uint_of(bytes: &[u8], element: Element) -> Option<u64> {
    let data = bytes.get(element.start..element.end)?;
    if data.is_empty() || data.len() > 8 {
        return None;
    }
    let mut value = 0u64;
    for byte in data {
        value = (value << 8) | u64::from(*byte);
    }
    Some(value)
}

fn float_of(bytes: &[u8], element: Element) -> Option<f64> {
    let data = bytes.get(element.start..element.end)?;
    match data.len() {
        4 => Some(f64::from(f32::from_be_bytes([
            data[0], data[1], data[2], data[3],
        ]))),
        8 => Some(f64::from_be_bytes([
            data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
        ])),
        _ => None,
    }
}

fn string_of(bytes: &[u8], element: Element) -> Option<String> {
    let data = bytes.get(element.start..element.end)?;
    let text = String::from_utf8_lossy(data).trim_end_matches('\0').to_string();
    (!text.is_empty()).then_some(text)
}

const SEGMENT: u64 = 0x1853_8067;
const INFO: u64 = 0x1549_A966;
const TRACKS: u64 = 0x1654_AE6B;
const TRACK_ENTRY: u64 = 0xAE;
const TIMECODE_SCALE: u64 = 0x2AD7_B1;
const DURATION: u64 = 0x4489;
const TRACK_TYPE: u64 = 0x83;
const PIXEL_WIDTH: u64 = 0xB0;
const PIXEL_HEIGHT: u64 = 0xBA;
const DEFAULT_DURATION: u64 = 0x23E3_83;
const CODEC_ID: u64 = 0x86;

/// Parses the WebM header: duration, video size/fps, and codec IDs. Returns
/// `None` when the bytes are not a usable Matroska/WebM header.
fn parse_webm_header(
    bytes: &[u8],
) -> Option<(f64, Option<u32>, Option<u32>, Option<f64>, Option<String>, Option<String>)> {
    let top = elements(bytes, 0, bytes.len());
    let segment = top.iter().find(|element| element.id == SEGMENT)?;
    let children = elements(bytes, segment.start, segment.end);
    let info = children.iter().find(|element| element.id == INFO)?;
    let info_children = elements(bytes, info.start, info.end);
    let scale = info_children
        .iter()
        .find(|element| element.id == TIMECODE_SCALE)
        .and_then(|element| uint_of(bytes, *element))
        .unwrap_or(1_000_000);
    let duration_units = info_children
        .iter()
        .find(|element| element.id == DURATION)
        .and_then(|element| float_of(bytes, *element))?;
    let duration = duration_units * scale as f64 / 1_000_000_000.0;
    let tracks = children.iter().find(|element| element.id == TRACKS)?;
    let entries = elements(bytes, tracks.start, tracks.end);
    let mut width = None;
    let mut height = None;
    let mut fps = None;
    let mut video_codec = None;
    let mut audio_codec = None;
    for entry in entries.iter().filter(|element| element.id == TRACK_ENTRY) {
        let fields = elements(bytes, entry.start, entry.end);
        let track_type = fields
            .iter()
            .find(|element| element.id == TRACK_TYPE)
            .and_then(|element| uint_of(bytes, *element));
        let codec = fields
            .iter()
            .find(|element| element.id == CODEC_ID)
            .and_then(|element| string_of(bytes, *element));
        match track_type {
            Some(1) if width.is_none() => {
                width = fields
                    .iter()
                    .find(|element| element.id == PIXEL_WIDTH)
                    .and_then(|element| uint_of(bytes, *element))
                    .map(|value| value as u32);
                height = fields
                    .iter()
                    .find(|element| element.id == PIXEL_HEIGHT)
                    .and_then(|element| uint_of(bytes, *element))
                    .map(|value| value as u32);
                let default_duration = fields
                    .iter()
                    .find(|element| element.id == DEFAULT_DURATION)
                    .and_then(|element| uint_of(bytes, *element));
                if let Some(nanos) = default_duration.filter(|nanos| *nanos > 0) {
                    let rate = 1_000_000_000.0 / nanos as f64;
                    if rate.is_finite() && rate > 0.0 {
                        fps = Some(rate);
                    }
                }
                video_codec = codec;
            }
            Some(2) if audio_codec.is_none() => audio_codec = codec,
            _ => {}
        }
    }
    if !duration.is_finite() || duration <= 0.0 {
        return None;
    }
    Some((duration, width, height, fps, video_codec, audio_codec))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("framecode-media-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn element(id: &[u8], payload: Vec<u8>) -> Vec<u8> {
        let mut out = id.to_vec();
        assert!(payload.len() < 127, "fixture sizes stay one-byte vints");
        out.push(0x80 | payload.len() as u8);
        out.extend(payload);
        out
    }

    fn uint(value: u64) -> Vec<u8> {
        let bytes = value.to_be_bytes();
        let first = bytes.iter().position(|byte| *byte != 0).unwrap_or(7);
        bytes[first..].to_vec()
    }

    fn float64(value: f64) -> Vec<u8> {
        value.to_be_bytes().to_vec()
    }

    /// A WebM header with Segment > Info (duration 12.5 s) and one video
    /// track (1920×1080, 30 fps via DefaultDuration).
    fn webm_header() -> Vec<u8> {
        let info = element(
            &[0x15, 0x49, 0xA9, 0x66],
            [
                element(&[0x2A, 0xD7, 0xB1], uint(1_000_000)),
                element(&[0x44, 0x89], float64(12_500.0)),
            ]
            .concat(),
        );
        let track = element(
            &[0xAE],
            [
                element(&[0x83], uint(1)),
                element(&[0xB0], uint(1920)),
                element(&[0xBA], uint(1080)),
                element(&[0x23, 0xE3, 0x83], uint(33_333_333)),
            ]
            .concat(),
        );
        let tracks = element(&[0x16, 0x54, 0xAE, 0x6B], track);
        let segment = element(&[0x18, 0x53, 0x80, 0x67], [info, tracks].concat());
        [element(&[0x1A, 0x45, 0xDF, 0xA3], Vec::new()), segment].concat()
    }

    #[test]
    fn extension_registry_separates_video_from_audio() {
        assert!(is_video_path("C:/clips/A.MP4"));
        assert!(is_video_path("C:/clips/b.webm"));
        assert!(!is_audio_path("C:/clips/b.webm"));
        assert!(is_audio_path("C:/audio/score.MP3"));
        assert!(is_audio_path("C:/audio/score.flac"));
        assert!(!is_video_path("C:/pics/hero.png"));
        assert!(!is_audio_path("C:/clips/a.txt"));
    }

    #[test]
    fn probing_webm_reads_duration_size_and_frame_rate() {
        let dir = unique_dir("webm");
        let path = dir.join("clip.webm");
        fs::write(&path, webm_header()).unwrap();
        let probe = probe_media(&path.to_string_lossy()).unwrap();
        assert_eq!(probe.kind, "video");
        assert_eq!(probe.duration, 12.5);
        assert_eq!(probe.width, Some(1920));
        assert_eq!(probe.height, Some(1080));
        let fps = probe.fps.unwrap();
        assert!((fps - 30.0).abs() < 0.01, "fps was {fps}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn probing_fails_closed_for_missing_unsupported_and_corrupt_files() {
        let dir = unique_dir("errors");
        let missing = dir.join("Gone.mp4");
        assert!(probe_media(&missing.to_string_lossy())
            .unwrap_err()
            .contains("missing"));
        let text = dir.join("note.txt");
        fs::write(&text, b"hello").unwrap();
        assert!(probe_media(&text.to_string_lossy())
            .unwrap_err()
            .contains("Unsupported media format"));
        let corrupt = dir.join("broken.mp4");
        fs::write(&corrupt, b"not an mp4").unwrap();
        let error = probe_media(&corrupt.to_string_lossy()).unwrap_err();
        assert!(!error.is_empty(), "a corrupt file yields a structured error");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_media_ceiling_is_four_gibibytes() {
        assert_eq!(MAX_MEDIA_BYTES, 4 * 1024 * 1024 * 1024);
    }

}
