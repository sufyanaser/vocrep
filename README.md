# NAS VocRep

Focused desktop preparation for Suno-generated tracks and separated stems before Cubase.

## Current checkpoint

The approved interface prototype is implemented as an interactive React/Vite surface on `develop`.

Working prototype interactions:

- Multi-file drag and drop / browse
- Track queue and selection
- Stereo to Mono toggle
- Normalize toggle
- Stem Repair toggle and strength selection
- 44.1 / 48 kHz selection
- Transport and synchronized A/B controls
- Simulated processing state and Cubase export feedback

Audio analysis and processing are intentionally not connected in this checkpoint.

## Local verification

```bash
npm install
npm run lint
npm run build
npm run dev
```

## Product architecture

See [`docs/PRODUCT_FOUNDATION.md`](docs/PRODUCT_FOUNDATION.md).
