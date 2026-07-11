use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::Path, process::Command};

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
    })
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
    metadata_from_ffprobe(path, &payload)
}

#[tauri::command]
fn probe_audio_files(paths: Vec<String>) -> Vec<Result<AudioMetadata, String>> {
    paths.into_iter().map(|path| probe_audio_path(&path)).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![probe_audio_files])
        .run(tauri::generate_context!())
        .expect("error while running NAS VocRep");
}

#[cfg(test)]
mod tests {
    use super::*;

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
