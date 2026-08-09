# NAS VocRep

NAS VocRep is a focused Windows desktop preparation station for Suno/Udio-generated tracks and separated stems before import into Cubase or another DAW.

## V04 checkpoint

V04 moves the project from conversion-only preparation into a deterministic FFmpeg DSP pipeline with real metadata, processing, output analysis, and A/B preview.

### Working pipeline

- Native multi-file drag and drop / browse.
- FFprobe metadata for container, codec, duration, sample rate, bit depth, channels, layout, and file size.
- Per-track or all-track processing scope.
- Channel modes: Keep Stereo, Mono Sum, Left Channel, Right Channel.
- De-Click and FFT noise cleanup controls.
- Optional 25 Hz subsonic high-pass.
- Optional 12 kHz / -1.5 dB high-shelf de-harsh stage.
- Optional 5 ms start/end micro-fades.
- Optional measured two-pass EBU R128 loudness normalization with -1 dBTP ceiling.
- Loudness targets: -14, -16, and -18 LUFS.
- Output sample rates: 44.1, 48, and 96 kHz.
- Output formats: 16-bit PCM, 24-bit PCM, and 32-bit float WAV.
- Output files written to a sibling `CUBASE_READY` directory with processing suffixes in the filename.
- Post-process FFprobe + loudness analysis.
- Processed waveform generation and synchronized A/B preview.
- Hidden FFmpeg/FFprobe subprocess windows on Windows.

## Factory presets

- **Vocal Stem Clean** — 25 Hz subsonic cut, 12 kHz de-harsh, -16 LUFS, 24-bit WAV.
- **Bass / Kick Sub-Fix** — 25 Hz subsonic cut, -14 LUFS, 24-bit WAV. Mono conversion remains an explicit user choice rather than a forced preset operation.
- **Acoustic & Synth Smooth** — 25 Hz subsonic cut, 12 kHz de-harsh, -16 LUFS, 24-bit WAV.
- **Bypass / Raw Conversion** — enhancement DSP and loudness normalization off; format/channel conversion remains available.

The default state is conservative: enhancement filters, normalization, and micro-fades are disabled until selected by the user or by a factory preset.

## Architecture

```text
React / Vite UI
      |
      v
Tauri command layer
      |
      v
Rust audio_pipeline module
      |
      +--> FFprobe metadata
      +--> FFmpeg deterministic DSP
      +--> two-pass loudnorm when enabled
      +--> WAV export
      +--> output analysis + waveform
```

The DSP layer is intentionally deterministic and transparent. V04 does not claim adaptive AI restoration; fixed cleanup stages are exposed as user-selectable operations.

## Runtime requirements

Current V04 development builds require `ffmpeg` and `ffprobe` to be available on `PATH`. The application performs an engine/filter capability check at startup and reports missing components instead of silently processing with a reduced pipeline.

## Verification gate

Repository CI validates:

```bash
npm ci
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Local Windows validation before a release build should additionally run:

```bash
npm run tauri:dev
```

Then process representative vocal, bass/kick, acoustic/synth, mono, and stereo stems and verify the resulting WAV files inside Cubase, including synchronization, channel layout, loudness, true peak, transients, and end tails.

## Product documentation

- [`docs/PRODUCT_FOUNDATION.md`](docs/PRODUCT_FOUNDATION.md)
- [`docs/NATIVE_SHELL_METADATA.md`](docs/NATIVE_SHELL_METADATA.md)


## Updates and releases

V04 introduces the Tauri signed updater path for Windows. Release builds check the repository's `latest.json` feed on startup; when a newer signed version is available, NAS VocRep downloads and installs it and restarts the app. GitHub Actions builds the signed NSIS updater artifact and publishes the release assets automatically, so users do not need to manually download and run a new installer for each version.

The updater signing private key must remain in GitHub Actions secrets. The matching public key is embedded in `src-tauri/tauri.conf.json`.
