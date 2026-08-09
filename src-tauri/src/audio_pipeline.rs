use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct LoudnormStats {
    pub input_i: f64,
    pub input_tp: f64,
    pub input_lra: f64,
    pub input_thresh: f64,
    pub target_offset: f64,
}

pub fn normalized_mode(mode: &str) -> String {
    mode.trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !matches!(character, ' ' | '-'))
        .collect()
}

pub fn channel_suffix(mode: &str) -> Result<&'static str, String> {
    match normalized_mode(mode).as_str() {
        "keepstereo" => Ok(""),
        "monosum" => Ok("_Mono"),
        "leftchannel" => Ok("_Left"),
        "rightchannel" => Ok("_Right"),
        _ => Err("Channel mode must be Keep Stereo, Mono Sum, Left Channel, or Right Channel".to_string()),
    }
}

pub fn output_codec(depth: u32) -> Result<&'static str, String> {
    match depth {
        16 => Ok("pcm_s16le"),
        24 => Ok("pcm_s24le"),
        32 => Ok("pcm_f32le"),
        _ => Err("Output depth must be 16, 24, or 32".to_string()),
    }
}

pub fn validate_sample_rate(sample_rate: u32) -> Result<(), String> {
    match sample_rate {
        44_100 | 48_000 | 96_000 => Ok(()),
        _ => Err("Sample rate must be 44100, 48000, or 96000".to_string()),
    }
}

pub fn de_click_filter(mode: &str) -> Result<Option<&'static str>, String> {
    match normalized_mode(mode).as_str() {
        "off" => Ok(None),
        "light" => Ok(Some("adeclick=w=40:o=70:a=2:t=2")),
        "balanced" => Ok(Some("adeclick=w=55:o=75:a=2:t=2")),
        "strong" => Ok(Some("adeclick=w=70:o=80:a=2:t=2")),
        _ => Err("De-Click mode must be Off, Light, Balanced, or Strong".to_string()),
    }
}

pub fn noise_cleanup_filter(mode: &str) -> Result<Option<&'static str>, String> {
    match normalized_mode(mode).as_str() {
        "off" => Ok(None),
        "light" => Ok(Some("afftdn=nf=-38:nr=5:tn=1")),
        "balanced" => Ok(Some("afftdn=nf=-34:nr=9:tn=1")),
        "strong" => Ok(Some("afftdn=nf=-30:nr=14:tn=1")),
        _ => Err("Noise Cleanup mode must be Off, Light, Balanced, or Strong".to_string()),
    }
}

#[derive(Debug, Clone)]
pub struct FilterChainConfig<'a> {
    pub channel_mode: &'a str,
    pub input_channels: u32,
    pub de_click_mode: &'a str,
    pub noise_cleanup_mode: &'a str,
    pub sub_bass_cut: bool,
    pub de_harshness: bool,
    pub enable_micro_fades: bool,
    pub duration_secs: f64,
}

pub fn build_base_filters(config: &FilterChainConfig<'_>) -> Result<Vec<String>, String> {
    let mut filters = Vec::new();

    match normalized_mode(config.channel_mode).as_str() {
        "leftchannel" => filters.push("pan=mono|c0=c0".to_string()),
        "rightchannel" => {
            if config.input_channels < 2 {
                return Err("Right Channel requires a stereo or multichannel source".to_string());
            }
            filters.push("pan=mono|c0=c1".to_string());
        }
        "monosum" => {
            if config.input_channels > 1 {
                filters.push("pan=mono|c0=0.5*c0+0.5*c1".to_string());
            }
        }
        "keepstereo" => {}
        _ => return Err("Unsupported channel mode".to_string()),
    }

    if config.sub_bass_cut {
        // A 25 Hz Butterworth high-pass also rejects DC without applying a no-op dcshift.
        filters.push("highpass=f=25:p=2:t=q:w=0.707".to_string());
    }

    if let Some(filter) = de_click_filter(config.de_click_mode)? {
        filters.push(filter.to_string());
    }

    if let Some(filter) = noise_cleanup_filter(config.noise_cleanup_mode)? {
        filters.push(filter.to_string());
    }

    if config.de_harshness {
        filters.push("highshelf=f=12000:g=-1.5:t=q:w=0.707".to_string());
    }

    if config.enable_micro_fades && config.duration_secs > 0.1 {
        let fade_out_start = (config.duration_secs - 0.005).max(0.0);
        filters.push("afade=t=in:ss=0:d=0.005".to_string());
        filters.push(format!("afade=t=out:st={fade_out_start:.6}:d=0.005"));
    }

    Ok(filters)
}

pub fn append_loudnorm_measurement(filters: &[String], target_lufs: f64) -> String {
    let mut chain = filters.to_vec();
    chain.push(format!(
        "loudnorm=I={target_lufs:.1}:TP=-1.0:LRA=11:print_format=json"
    ));
    chain.join(",")
}

pub fn append_loudnorm_second_pass(
    filters: &[String],
    target_lufs: f64,
    stats: &LoudnormStats,
) -> String {
    let mut chain = filters.to_vec();
    chain.push(format!(
        concat!(
            "loudnorm=I={target_lufs:.1}:TP=-1.0:LRA=11:",
            "measured_I={input_i:.6}:measured_TP={input_tp:.6}:",
            "measured_LRA={input_lra:.6}:measured_thresh={input_thresh:.6}:",
            "offset={target_offset:.6}:linear=true:print_format=summary"
        ),
        target_lufs = target_lufs,
        input_i = stats.input_i,
        input_tp = stats.input_tp,
        input_lra = stats.input_lra,
        input_thresh = stats.input_thresh,
        target_offset = stats.target_offset,
    ));
    chain.join(",")
}

fn json_number(payload: &Value, key: &str) -> Result<f64, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .ok_or_else(|| format!("Missing or invalid loudnorm field: {key}"))
}

pub fn parse_loudnorm_stats(stderr: &str) -> Result<LoudnormStats, String> {
    let start = stderr
        .rfind('{')
        .ok_or_else(|| "Loudnorm JSON not found".to_string())?;
    let end = stderr
        .rfind('}')
        .ok_or_else(|| "Loudnorm JSON is incomplete".to_string())?;
    if end < start {
        return Err("Loudnorm JSON is malformed".to_string());
    }

    let payload: Value = serde_json::from_str(&stderr[start..=end])
        .map_err(|error| format!("Invalid loudnorm response: {error}"))?;

    Ok(LoudnormStats {
        input_i: json_number(&payload, "input_i")?,
        input_tp: json_number(&payload, "input_tp")?,
        input_lra: json_number(&payload, "input_lra")?,
        input_thresh: json_number(&payload, "input_thresh")?,
        target_offset: json_number(&payload, "target_offset")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    #[test]
    fn builds_requested_cleanup_chain() {
        let filters = build_base_filters(&FilterChainConfig {
            channel_mode: "Keep Stereo",
            input_channels: 2,
            de_click_mode: "Light",
            noise_cleanup_mode: "Off",
            sub_bass_cut: true,
            de_harshness: true,
            enable_micro_fades: true,
            duration_secs: 10.0,
        })
        .unwrap();

        assert!(filters.iter().any(|value| value.starts_with("highpass=")));
        assert!(filters.iter().any(|value| value.starts_with("adeclick=")));
        assert!(filters.iter().any(|value| value.starts_with("highshelf=")));
        assert!(filters.iter().any(|value| value.starts_with("afade=t=in")));
        assert!(filters.iter().any(|value| value.contains("st=9.995000")));
    }

    #[test]
    fn mono_sum_is_in_filter_graph_for_measurement_accuracy() {
        let filters = build_base_filters(&FilterChainConfig {
            channel_mode: "Mono Sum",
            input_channels: 2,
            de_click_mode: "Off",
            noise_cleanup_mode: "Off",
            sub_bass_cut: false,
            de_harshness: false,
            enable_micro_fades: false,
            duration_secs: 1.0,
        })
        .unwrap();
        assert_eq!(filters.first().unwrap(), "pan=mono|c0=0.5*c0+0.5*c1");
    }

    #[test]
    fn parses_two_pass_measurements() {
        let stderr = r#"prefix
{
  "input_i" : "-20.10",
  "input_tp" : "-3.20",
  "input_lra" : "4.50",
  "input_thresh" : "-30.25",
  "target_offset" : "0.30"
}
"#;
        let stats = parse_loudnorm_stats(stderr).unwrap();
        assert_eq!(stats.input_i, -20.10);
        assert_eq!(stats.target_offset, 0.30);
    }

    #[test]
    fn supports_requested_output_formats() {
        assert_eq!(output_codec(16).unwrap(), "pcm_s16le");
        assert_eq!(output_codec(24).unwrap(), "pcm_s24le");
        assert_eq!(output_codec(32).unwrap(), "pcm_f32le");
        assert!(validate_sample_rate(96_000).is_ok());
    }

    #[test]
    fn ffmpeg_executes_v04_chain_and_two_pass_loudnorm() {
        let available = Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !available {
            eprintln!("FFmpeg is unavailable; skipping runtime DSP validation");
            return;
        }

        let filters = build_base_filters(&FilterChainConfig {
            channel_mode: "Keep Stereo",
            input_channels: 1,
            de_click_mode: "Light",
            noise_cleanup_mode: "Light",
            sub_bass_cut: true,
            de_harshness: true,
            enable_micro_fades: true,
            duration_secs: 2.0,
        })
        .unwrap();
        let source = "sine=frequency=440:sample_rate=48000:duration=2";
        let first_pass = append_loudnorm_measurement(&filters, -16.0);
        let measurement = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-nostdin",
                "-nostats",
                "-f",
                "lavfi",
                "-i",
                source,
                "-af",
                &first_pass,
                "-f",
                "null",
                "-",
            ])
            .output()
            .expect("FFmpeg measurement process should start");
        assert!(
            measurement.status.success(),
            "FFmpeg first pass failed: {}",
            String::from_utf8_lossy(&measurement.stderr)
        );

        let stats = parse_loudnorm_stats(&String::from_utf8_lossy(&measurement.stderr))
            .expect("First pass should return loudnorm JSON");
        let second_pass = append_loudnorm_second_pass(&filters, -16.0, &stats);
        let output_path = std::env::temp_dir().join(format!(
            "vocrep-v04-dsp-runtime-{}.wav",
            std::process::id()
        ));
        let output_path_string = output_path.to_string_lossy().to_string();
        let processing = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                source,
                "-af",
                &second_pass,
                "-ar",
                "48000",
                "-c:a",
                "pcm_s24le",
                "-y",
                &output_path_string,
            ])
            .output()
            .expect("FFmpeg processing process should start");
        assert!(
            processing.status.success(),
            "FFmpeg second pass failed: {}",
            String::from_utf8_lossy(&processing.stderr)
        );

        let output_size = fs::metadata(&output_path)
            .expect("Runtime DSP test should produce a WAV file")
            .len();
        assert!(output_size > 44, "Runtime DSP WAV should contain audio data");
        let _ = fs::remove_file(output_path);
    }
}
