use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, process::Command};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadata {
    pub path: String,
    pub name: String,
    pub container: String,
    pub codec: String,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub bit_depth: Option<u32>,
    pub channels: u32,
    pub channel_layout: String,
    pub file_size: u64,
    pub source: String,
    pub integrated_lufs: Option<f64>,
    pub true_peak_dbtp: Option<f64>,
}

fn parse_number<T: std::str::FromStr>(value: Option<&Value>) -> Option<T> {
    value.and_then(Value::as_str).and_then(|raw| raw.parse::<T>().ok())
}

fn metadata_from_ffprobe(path: &str, payload: &Value) -> Result<AudioMetadata, String> {
    let streams = payload["streams"]
        .as_array()
        .ok_or_else(|| "FFprobe returned no streams".to_string())?;
    let stream = streams
        .iter()
        .find(|stream| stream["codec_type"] == "audio")
        .ok_or_else(|| "No audio stream found".to_string())?;
    let format = &payload["format"];
    let duration_seconds = parse_number::<f64>(format.get("duration"))
        .or_else(|| parse_number::<f64>(stream.get("duration")))
        .unwrap_or(0.0);
    let sample_rate = parse_number::<u32>(stream.get("sample_rate")).unwrap_or(0);
    let bit_depth = stream["bits_per_raw_sample"]
        .as_str()
        .filter(|value| !value.is_empty() && *value != "0")
        .and_then(|value| value.parse::<u32>().ok())
        .or_else(|| stream["bits_per_sample"].as_u64().map(|value| value as u32))
        .filter(|value| *value > 0);
    let channels = stream["channels"].as_u64().unwrap_or(0) as u32;
    let channel_layout = stream["channel_layout"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| match channels {
            1 => "mono".to_string(),
            2 => "stereo".to_string(),
            count => format!("{count} channels"),
        });
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string();

    Ok(AudioMetadata {
        path: path.to_string(),
        name,
        container: format["format_name"].as_str().unwrap_or("unknown").to_uppercase(),
        codec: stream["codec_long_name"]
            .as_str()
            .or_else(|| stream["codec_name"].as_str())
            .unwrap_or("unknown")
            .to_string(),
        duration_seconds,
        sample_rate,
        bit_depth,
        channels,
        channel_layout,
        file_size: parse_number::<u64>(format.get("size")).unwrap_or(0),
        source: "ffprobe".to_string(),
        integrated_lufs: None,
        true_peak_dbtp: None,
    })
}

fn analyze_loudness(path: &str) -> Result<(f64, f64), String> {
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner", "-nostats", "-i", path,
            "-af", "loudnorm=I=-18:TP=-1:LRA=11:print_format=json",
            "-f", "null", "-",
        ])
        .output()
        .map_err(|error| format!("Unable to start FFmpeg analysis: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let start = stderr.rfind('{').ok_or_else(|| "Loudness JSON not found".to_string())?;
    let end = stderr.rfind('}').ok_or_else(|| "Loudness JSON is incomplete".to_string())?;
    let payload: Value = serde_json::from_str(&stderr[start..=end])
        .map_err(|error| format!("Invalid loudness response: {error}"))?;
    let integrated = parse_number::<f64>(payload.get("input_i"))
        .ok_or_else(|| "Integrated LUFS missing".to_string())?;
    let true_peak = parse_number::<f64>(payload.get("input_tp"))
        .ok_or_else(|| "True peak missing".to_string())?;
    Ok((integrated, true_peak))
}

fn probe_audio_path(path: &str) -> Result<AudioMetadata, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=format_name,duration,size:stream=codec_type,codec_name,codec_long_name,sample_rate,bits_per_sample,bits_per_raw_sample,channels,channel_layout,duration",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|error| format!("Unable to start FFprobe: {error}"))?;

    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() { "FFprobe failed".to_string() } else { message });
    }

    let payload: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid FFprobe response: {error}"))?;
    let mut metadata = metadata_from_ffprobe(path, &payload)?;
    if let Ok((integrated_lufs, true_peak_dbtp)) = analyze_loudness(path) {
        metadata.integrated_lufs = Some(integrated_lufs);
        metadata.true_peak_dbtp = Some(true_peak_dbtp);
    }
    Ok(metadata)
}

#[tauri::command]
fn probe_audio_files(paths: Vec<String>) -> Vec<Result<AudioMetadata, String>> {
    paths.into_iter().map(|path| probe_audio_path(&path)).collect()
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOptions {
    pub mono: bool,
    pub normalize: bool,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResult {
    pub input_path: String,
    pub output_path: String,
}

fn output_path_for(input: &Path, options: &ProcessOptions) -> Result<PathBuf, String> {
    let parent = input.parent().ok_or_else(|| "Input file has no parent folder".to_string())?;
    let output_dir = parent.join("CUBASE_READY");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Unable to create CUBASE_READY: {error}"))?;
    let stem = input.file_stem().and_then(|value| value.to_str()).unwrap_or("track");
    let channel = if options.mono { "_Mono" } else { "" };
    let rate = if options.sample_rate == 44_100 { "_44k" } else { "_48k" };
    Ok(output_dir.join(format!("{stem}_Ready{channel}{rate}.wav")))
}

fn process_audio_path(path: &str, options: &ProcessOptions) -> Result<ProcessResult, String> {
    if options.sample_rate != 44_100 && options.sample_rate != 48_000 {
        return Err("Sample rate must be 44100 or 48000".to_string());
    }
    let input = Path::new(path);
    if !input.is_file() {
        return Err(format!("Audio file not found: {path}"));
    }
    let output_path = output_path_for(input, options)?;
    let mut command = Command::new("ffmpeg");
    command.args(["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-vn"]);
    if options.mono {
        command.args(["-ac", "1"]);
    }
    if options.normalize {
        command.args(["-af", "loudnorm=I=-18:TP=-1.0:LRA=11"]);
    }
    command.args([
        "-ar",
        &options.sample_rate.to_string(),
        "-c:a",
        "pcm_s24le",
        output_path.to_string_lossy().as_ref(),
    ]);
    let result = command.output().map_err(|error| format!("Unable to start FFmpeg: {error}"))?;
    if !result.status.success() {
        let message = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if message.is_empty() { "FFmpeg processing failed".to_string() } else { message });
    }
    Ok(ProcessResult {
        input_path: path.to_string(),
        output_path: output_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn process_audio_files(
    paths: Vec<String>,
    options: ProcessOptions,
) -> Vec<Result<ProcessResult, String>> {
    paths.into_iter().map(|path| process_audio_path(&path, &options)).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![probe_audio_files, process_audio_files])
        .run(tauri::generate_context!())
        .expect("error while running NAS VocRep");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_loudness_numbers() {
        let payload = serde_json::json!({ "input_i": "-17.82", "input_tp": "-1.14" });
        assert_eq!(parse_number::<f64>(payload.get("input_i")), Some(-17.82));
        assert_eq!(parse_number::<f64>(payload.get("input_tp")), Some(-1.14));
    }

    #[test]
    fn creates_cubase_ready_output_name() {
        let options = ProcessOptions { mono: true, normalize: true, sample_rate: 48_000 };
        let output = output_path_for(Path::new("/tmp/Song01 Vocal.wav"), &options).unwrap();
        assert!(output.ends_with("CUBASE_READY/Song01 Vocal_Ready_Mono_48k.wav"));
    }

    #[test]
    fn parses_pcm_wave_metadata() {
        let payload: Value = serde_json::json!({
            "streams": [{
                "codec_type": "audio",
                "codec_name": "pcm_s24le",
                "codec_long_name": "PCM signed 24-bit little-endian",
                "sample_rate": "48000",
                "bits_per_sample": 24,
                "channels": 2,
                "channel_layout": "stereo"
            }],
            "format": {
                "format_name": "wav",
                "duration": "222.125",
                "size": "63972044"
            }
        });

        let metadata = metadata_from_ffprobe("C:/Audio/Song01_Vocal.wav", &payload).unwrap();
        assert_eq!(metadata.name, "Song01_Vocal.wav");
        assert_eq!(metadata.sample_rate, 48_000);
        assert_eq!(metadata.bit_depth, Some(24));
        assert_eq!(metadata.channels, 2);
        assert_eq!(metadata.duration_seconds, 222.125);
        assert_eq!(metadata.file_size, 63_972_044);
    }
}
