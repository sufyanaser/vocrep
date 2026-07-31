use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::Emitter;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn hidden_command(program: &str) -> Command {
    let command = Command::new(program);

    #[cfg(windows)]
    {
        let mut command = command;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(not(windows))]
    {
        command
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEngineStatus {
    pub ready: bool,
    pub ffmpeg_version: Option<String>,
    pub ffprobe_version: Option<String>,
    pub missing_filters: Vec<String>,
    pub error: Option<String>,
}

fn first_version_line(tool: &str) -> Result<String, String> {
    let output = hidden_command(tool)
        .arg("-version")
        .output()
        .map_err(|error| format!("Unable to start {tool}: {error}"))?;
    if !output.status.success() {
        return Err(format!("{tool} version check failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("unknown version")
        .to_string())
}

#[tauri::command]
fn check_audio_engine() -> AudioEngineStatus {
    let ffmpeg_version = first_version_line("ffmpeg");
    let ffprobe_version = first_version_line("ffprobe");
    let engine_error = ffmpeg_version
        .as_ref()
        .err()
        .or_else(|| ffprobe_version.as_ref().err())
        .cloned();
    if let Some(error) = engine_error {
        return AudioEngineStatus {
            ready: false,
            ffmpeg_version: ffmpeg_version.ok(),
            ffprobe_version: ffprobe_version.ok(),
            missing_filters: Vec::new(),
            error: Some(error),
        };
    }

    let filters_output = hidden_command("ffmpeg")
        .args(["-hide_banner", "-nostdin", "-filters"])
        .output();
    let filters = match filters_output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).to_string()
        }
        Ok(_) => String::new(),
        Err(error) => {
            return AudioEngineStatus {
                ready: false,
                ffmpeg_version: ffmpeg_version.ok(),
                ffprobe_version: ffprobe_version.ok(),
                missing_filters: Vec::new(),
                error: Some(format!("Unable to inspect FFmpeg filters: {error}")),
            }
        }
    };

    let required = ["adeclick", "afftdn", "loudnorm", "pan"];
    let missing_filters = required
        .iter()
        .filter(|name| !filters.contains(*name))
        .map(|name| name.to_string())
        .collect::<Vec<_>>();

    AudioEngineStatus {
        ready: missing_filters.is_empty(),
        ffmpeg_version: ffmpeg_version.ok(),
        ffprobe_version: ffprobe_version.ok(),
        error: if missing_filters.is_empty() {
            None
        } else {
            Some("Required FFmpeg filters are unavailable".to_string())
        },
        missing_filters,
    }
}

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
    value
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<T>().ok())
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
        container: format["format_name"]
            .as_str()
            .unwrap_or("unknown")
            .to_uppercase(),
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

fn parse_loudness_value(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|number| number.is_finite())
}

fn analyze_loudness(path: &str) -> Result<(Option<f64>, Option<f64>), String> {
    let output = hidden_command("ffmpeg")
        .args([
            "-hide_banner",
            "-nostdin",
            "-nostats",
            "-i",
            path,
            "-af",
            "loudnorm=I=-18:TP=-1:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|error| format!("Unable to start FFmpeg analysis: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let start = stderr
        .rfind('{')
        .ok_or_else(|| "Loudness JSON not found".to_string())?;
    let end = stderr
        .rfind('}')
        .ok_or_else(|| "Loudness JSON is incomplete".to_string())?;
    let payload: Value = serde_json::from_str(&stderr[start..=end])
        .map_err(|error| format!("Invalid loudness response: {error}"))?;
    let integrated = parse_loudness_value(payload.get("input_i"));
    let true_peak = parse_loudness_value(payload.get("input_tp"));
    Ok((integrated, true_peak))
}

fn probe_audio_metadata(path: &str) -> Result<AudioMetadata, String> {
    let output = hidden_command("ffprobe")
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
        return Err(if message.is_empty() {
            "FFprobe failed".to_string()
        } else {
            message
        });
    }

    let payload: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid FFprobe response: {error}"))?;
    metadata_from_ffprobe(path, &payload)
}

fn is_processed_output(path: &str) -> bool {
    Path::new(path).components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("CUBASE_READY")
    })
}

fn analyze_processed_output(path: &str) -> Result<AudioMetadata, String> {
    let mut metadata = probe_audio_metadata(path)?;
    let (integrated_lufs, true_peak_dbtp) = analyze_loudness(path)?;
    metadata.integrated_lufs = integrated_lufs;
    metadata.true_peak_dbtp = true_peak_dbtp;
    Ok(metadata)
}

fn probe_audio_path(path: &str) -> Result<AudioMetadata, String> {
    if is_processed_output(path) {
        analyze_processed_output(path)
    } else {
        probe_audio_metadata(path)
    }
}

#[tauri::command]
fn probe_audio_files(paths: Vec<String>) -> Vec<Result<AudioMetadata, String>> {
    paths
        .into_iter()
        .map(|path| probe_audio_path(&path))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOptions {
    pub channel_mode: String,
    pub normalize: bool,
    pub de_click_mode: String,
    pub noise_cleanup_mode: String,
    pub sample_rate: u32,
    pub output_depth: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformData {
    pub channels: u32,
    pub peaks: Vec<Vec<f32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedTrackResult {
    pub input_path: String,
    pub output_path: String,
    pub output_folder: String,
    pub metadata: AudioMetadata,
    pub waveform: WaveformData,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessingStageEvent {
    job_id: String,
    stage: String,
    status: String,
    message: Option<String>,
}

fn emit_stage(
    app: &tauri::AppHandle,
    job_id: &str,
    stage: &str,
    status: &str,
    message: Option<String>,
) {
    let _ = app.emit(
        "vocrep://processing-stage",
        ProcessingStageEvent {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            status: status.to_string(),
            message,
        },
    );
}

fn waveform_from_pcm(bytes: &[u8], channels: usize, points: usize) -> WaveformData {
    let samples = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect::<Vec<_>>();
    let frames = samples.len() / channels.max(1);
    let point_count = points.max(1).min(frames.max(1));
    let mut peaks = vec![vec![0.0_f32; point_count]; channels.max(1)];
    if frames == 0 {
        return WaveformData {
            channels: channels as u32,
            peaks,
        };
    }
    for point in 0..point_count {
        let start = point * frames / point_count;
        let end = ((point + 1) * frames / point_count)
            .max(start + 1)
            .min(frames);
        for frame in start..end {
            for channel in 0..channels {
                let sample = samples[frame * channels + channel].abs();
                peaks[channel][point] = peaks[channel][point].max(sample);
            }
        }
    }
    WaveformData {
        channels: channels as u32,
        peaks,
    }
}

fn extract_waveform(path: &str, points: usize) -> Result<WaveformData, String> {
    let metadata = probe_audio_metadata(path)?;
    let channels = metadata.channels.max(1) as usize;
    let output = hidden_command("ffmpeg")
        .args([
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            path,
            "-vn",
            "-ar",
            "2000",
            "-c:a",
            "pcm_f32le",
            "-f",
            "f32le",
            "-",
        ])
        .output()
        .map_err(|error| format!("Unable to decode waveform: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "Waveform decode failed".to_string()
        } else {
            message
        });
    }
    Ok(waveform_from_pcm(&output.stdout, channels, points))
}

#[tauri::command]
fn get_audio_waveform(path: String, points: usize) -> Result<WaveformData, String> {
    extract_waveform(&path, points.clamp(128, 2048))
}

fn normalized_mode(mode: &str) -> String {
    mode.trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !matches!(character, ' ' | '-'))
        .collect()
}

fn channel_suffix(mode: &str) -> Result<&'static str, String> {
    match normalized_mode(mode).as_str() {
        "keepstereo" => Ok(""),
        "monosum" => Ok("_Mono"),
        "leftchannel" => Ok("_Left"),
        "rightchannel" => Ok("_Right"),
        _ => Err("Channel mode must be Keep Stereo, Mono Sum, Left Channel, or Right Channel".to_string()),
    }
}

fn de_click_filter(mode: &str) -> Result<Option<&'static str>, String> {
    match normalized_mode(mode).as_str() {
        "off" => Ok(None),
        "light" => Ok(Some("adeclick=w=40:o=70:a=2:t=2")),
        "balanced" => Ok(Some("adeclick=w=55:o=75:a=2:t=2")),
        "strong" => Ok(Some("adeclick=w=70:o=80:a=2:t=2")),
        _ => Err("De-Click mode must be Off, Light, Balanced, or Strong".to_string()),
    }
}

fn noise_cleanup_filter(mode: &str) -> Result<Option<&'static str>, String> {
    match normalized_mode(mode).as_str() {
        "off" => Ok(None),
        "light" => Ok(Some("afftdn=nf=-38:nr=5:tn=1")),
        "balanced" => Ok(Some("afftdn=nf=-34:nr=9:tn=1")),
        "strong" => Ok(Some("afftdn=nf=-30:nr=14:tn=1")),
        _ => Err("Noise Cleanup mode must be Off, Light, Balanced, or Strong".to_string()),
    }
}

fn output_codec(depth: u32) -> Result<&'static str, String> {
    match depth {
        24 => Ok("pcm_s24le"),
        32 => Ok("pcm_f32le"),
        _ => Err("Output depth must be 24 or 32".to_string()),
    }
}

fn output_path_for(input: &Path, options: &ProcessOptions) -> Result<PathBuf, String> {
    let parent = input
        .parent()
        .ok_or_else(|| "Input file has no parent folder".to_string())?;
    let output_dir = parent.join("CUBASE_READY");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Unable to create CUBASE_READY: {error}"))?;
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("track");
    let channel = channel_suffix(&options.channel_mode)?;
    let rate = if options.sample_rate == 44_100 { "_44k" } else { "_48k" };
    let depth = if options.output_depth == 32 { "_32f" } else { "_24b" };
    Ok(output_dir.join(format!("{stem}_Ready{channel}{rate}{depth}.wav")))
}

fn prepare_processing(path: &str, options: &ProcessOptions) -> Result<(PathBuf, PathBuf, u32), String> {
    if options.sample_rate != 44_100 && options.sample_rate != 48_000 {
        return Err("Sample rate must be 44100 or 48000".to_string());
    }
    output_codec(options.output_depth)?;
    channel_suffix(&options.channel_mode)?;
    de_click_filter(&options.de_click_mode)?;
    noise_cleanup_filter(&options.noise_cleanup_mode)?;

    let input = PathBuf::from(path);
    if !input.is_file() {
        return Err(format!("Audio file not found: {path}"));
    }
    let metadata = probe_audio_metadata(path)?;
    if normalized_mode(&options.channel_mode) == "rightchannel" && metadata.channels < 2 {
        return Err("Right Channel requires a stereo or multichannel source".to_string());
    }
    let output = output_path_for(&input, options)?;
    Ok((input, output, metadata.channels))
}

fn run_processing(
    input: &Path,
    output: &Path,
    options: &ProcessOptions,
    input_channels: u32,
) -> Result<(), String> {
    let input_path = input.to_string_lossy();
    let output_path = output.to_string_lossy();
    let mut command = hidden_command("ffmpeg");
    command.args([
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input_path.as_ref(),
        "-vn",
    ]);

    let mut filters = Vec::new();
    match normalized_mode(&options.channel_mode).as_str() {
        "leftchannel" => filters.push("pan=mono|c0=c0".to_string()),
        "rightchannel" => filters.push("pan=mono|c0=c1".to_string()),
        _ => {}
    }
    if let Some(filter) = de_click_filter(&options.de_click_mode)? {
        filters.push(filter.to_string());
    }
    if let Some(filter) = noise_cleanup_filter(&options.noise_cleanup_mode)? {
        filters.push(filter.to_string());
    }
    if options.normalize {
        filters.push("loudnorm=I=-18:TP=-1.0:LRA=11".to_string());
    }
    if !filters.is_empty() {
        command.args(["-af", &filters.join(",")]);
    }

    if normalized_mode(&options.channel_mode) == "monosum" && input_channels > 1 {
        command.args(["-ac", "1"]);
    }

    command.args([
        "-ar",
        &options.sample_rate.to_string(),
        "-c:a",
        output_codec(options.output_depth)?,
        output_path.as_ref(),
    ]);

    let result = command
        .output()
        .map_err(|error| format!("Unable to start FFmpeg: {error}"))?;
    if !result.status.success() {
        let message = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "FFmpeg processing failed".to_string()
        } else {
            message
        });
    }
    Ok(())
}

fn process_audio_track_blocking(
    app: tauri::AppHandle,
    job_id: String,
    path: String,
    options: ProcessOptions,
) -> Result<ProcessedTrackResult, String> {
    emit_stage(&app, &job_id, "preparing", "active", None);
    let (input, output, input_channels) = match prepare_processing(&path, &options) {
        Ok(value) => value,
        Err(error) => {
            emit_stage(&app, &job_id, "preparing", "error", Some(error.clone()));
            return Err(error);
        }
    };
    emit_stage(&app, &job_id, "preparing", "done", None);

    emit_stage(&app, &job_id, "processing", "active", None);
    if let Err(error) = run_processing(&input, &output, &options, input_channels) {
        emit_stage(&app, &job_id, "processing", "error", Some(error.clone()));
        return Err(error);
    }
    emit_stage(&app, &job_id, "processing", "done", None);

    let output_path = output.to_string_lossy().to_string();
    emit_stage(&app, &job_id, "analyzing", "active", None);
    let metadata = match analyze_processed_output(&output_path) {
        Ok(value) => value,
        Err(error) => {
            emit_stage(&app, &job_id, "analyzing", "error", Some(error.clone()));
            return Err(error);
        }
    };
    emit_stage(&app, &job_id, "analyzing", "done", None);

    emit_stage(&app, &job_id, "preview", "active", None);
    let waveform = match extract_waveform(&output_path, 900) {
        Ok(value) => value,
        Err(error) => {
            emit_stage(&app, &job_id, "preview", "error", Some(error.clone()));
            return Err(error);
        }
    };
    emit_stage(&app, &job_id, "preview", "done", None);
    emit_stage(&app, &job_id, "complete", "done", None);

    let output_folder = output
        .parent()
        .map(|folder| folder.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(ProcessedTrackResult {
        input_path: path,
        output_path,
        output_folder,
        metadata,
        waveform,
    })
}

#[tauri::command]
async fn process_audio_track(
    app: tauri::AppHandle,
    job_id: String,
    path: String,
    options: ProcessOptions,
) -> Result<ProcessedTrackResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        process_audio_track_blocking(app, job_id, path, options)
    })
    .await
    .map_err(|error| format!("Processing task failed: {error}"))?
}

#[tauri::command]
fn open_output_folder(folder_path: String) -> Result<(), String> {
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("Output folder not found: {folder_path}"));
    }

    #[cfg(windows)]
    let result = hidden_command("explorer.exe").arg(&folder).spawn();
    #[cfg(target_os = "macos")]
    let result = hidden_command("open").arg(&folder).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = hidden_command("xdg-open").arg(&folder).spawn();

    result
        .map(|_| ())
        .map_err(|error| format!("Unable to open output folder: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_audio_engine,
            probe_audio_files,
            get_audio_waveform,
            process_audio_track,
            open_output_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running NAS VocRep");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_options() -> ProcessOptions {
        ProcessOptions {
            channel_mode: "Mono Sum".to_string(),
            normalize: true,
            de_click_mode: "Balanced".to_string(),
            noise_cleanup_mode: "Light".to_string(),
            sample_rate: 48_000,
            output_depth: 32,
        }
    }

    #[test]
    fn parses_loudness_numbers() {
        let payload = serde_json::json!({ "input_i": "-17.82", "input_tp": "-1.14" });
        assert_eq!(parse_loudness_value(payload.get("input_i")), Some(-17.82));
        assert_eq!(parse_loudness_value(payload.get("input_tp")), Some(-1.14));
    }

    #[test]
    fn identifies_processed_output_path() {
        let output = Path::new("/tmp").join("CUBASE_READY").join("Song01.wav");
        assert!(is_processed_output(output.to_string_lossy().as_ref()));
        assert!(!is_processed_output("/tmp/Song01.wav"));
    }

    #[test]
    fn resolves_independent_cleanup_profiles() {
        assert!(de_click_filter("Off").unwrap().is_none());
        assert!(de_click_filter("Balanced").unwrap().unwrap().contains("adeclick"));
        assert!(noise_cleanup_filter("Light").unwrap().unwrap().contains("nr=5"));
        assert!(noise_cleanup_filter("Strong").unwrap().unwrap().contains("nr=14"));
    }

    #[test]
    fn resolves_output_codecs() {
        assert_eq!(output_codec(24).unwrap(), "pcm_s24le");
        assert_eq!(output_codec(32).unwrap(), "pcm_f32le");
        assert!(output_codec(16).is_err());
    }

    #[test]
    fn creates_cubase_ready_output_name() {
        let output = output_path_for(Path::new("/tmp/Song01 Vocal.wav"), &test_options()).unwrap();
        assert!(output.ends_with("CUBASE_READY/Song01 Vocal_Ready_Mono_48k_32f.wav"));
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

    #[test]
    fn creates_channel_accurate_waveform_peaks() {
        let samples = [0.1_f32, -0.8, 0.6, 0.2, -0.4, 0.9, 0.3, -0.1];
        let bytes = samples
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        let waveform = waveform_from_pcm(&bytes, 2, 2);
        assert_eq!(waveform.channels, 2);
        assert_eq!(waveform.peaks[0], vec![0.6, 0.4]);
        assert_eq!(waveform.peaks[1], vec![0.8, 0.9]);
    }
}
