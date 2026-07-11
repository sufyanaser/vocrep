# NAS VocRep

Focused desktop preparation for Suno-generated tracks and separated stems before Cubase.

## Current checkpoint

The approved interface is implemented on `develop`, with a Tauri 2 desktop shell and truthful metadata ingestion.

Working prototype interactions:

- Native multi-file drag and drop / browse
- Track queue and selection
- FFprobe-backed container, codec, duration, sample rate, bit depth, channels, and file-size metadata
- Stereo to Mono toggle
- Normalize toggle
- Stem Repair toggle and strength selection
- 44.1 / 48 kHz selection
- Transport and synchronized A/B controls
- Simulated processing state and Cubase export feedback

Loudness analysis and audio processing are intentionally not connected in this checkpoint. Imported files show `Pending` instead of fabricated True Peak or LUFS values.

## Local verification

```bash
npm install
npm run lint
npm run build
npm run dev
npm run tauri:dev
```

## Product architecture

See [`docs/PRODUCT_FOUNDATION.md`](docs/PRODUCT_FOUNDATION.md).

Native metadata details: [`docs/NATIVE_SHELL_METADATA.md`](docs/NATIVE_SHELL_METADATA.md).
