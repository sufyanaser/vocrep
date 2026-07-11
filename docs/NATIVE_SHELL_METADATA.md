# Native Shell and Metadata Checkpoint

## Scope

This checkpoint introduces the Tauri 2 desktop shell and truthful file metadata ingestion. It does not perform loudness analysis or audio repair yet.

## Import paths

### Desktop runtime

- Native multi-file dialog through `@tauri-apps/plugin-dialog`.
- Operating-system drag and drop through `onDragDropEvent`.
- Selected paths are sent to the Rust command `probe_audio_files`.
- Rust launches local `ffprobe` and returns structured metadata.

### Browser verification runtime

- Multi-file input remains available for interface verification.
- WAV metadata is read directly from the RIFF `fmt ` chunk.
- The browser decoder supplies duration and fallback channel data.
- Browser-decoded sample rate is never treated as the original WAV rate because Web Audio may resample during decode.

## Factual metadata contract

- File name and local path (desktop only)
- Container
- Codec
- Duration
- Original sample rate
- Original bit depth when reported by the container/codec
- Channel count and layout
- File size
- Metadata source (`ffprobe` or `browser`)

## Deliberately pending

- True Peak
- Integrated LUFS
- RMS
- Dynamic range
- Noise floor
- Clipping count
- Artifact likelihood

These fields display `Pending` or `—` for imported files until the analysis engine is implemented. No placeholder value is presented as a real measurement.

## Verification

- Browser fixture: 2-second WAV, PCM 24-bit, 48 kHz, stereo.
- Observed UI values: WAV, 48 kHz, 24-bit, stereo, 00:02.
- Frontend lint and production build pass locally.
- Rust validation runs in GitHub Actions because the current local execution environment does not include the Rust toolchain.
