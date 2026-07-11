# NAS VocRep — Product Foundation

**Working product name:** NAS VocRep  
**Purpose:** Prepare Suno-generated tracks and separated stems for reliable use in Cubase.  
**Current gate:** Strategy → Architecture → Wireframe. No implementation before visual approval.

## 1. Product Boundary

VocRep is a focused preparation station, not a DAW, mastering suite, or stem-separation application.

### Primary job

1. Import one or many audio files.
2. Inspect the files with factual audio measurements.
3. Detect likely technical problems.
4. Apply an explicit, reversible repair chain.
5. Compare original and processed audio.
6. Export Cubase-ready WAV files.

### MVP functions

- Multi-file drag/drop and browse
- Organized side queue
- Real metadata and technical measurements
- Stereo to Mono
- Peak or LUFS normalization
- DC-offset correction
- Click/pop repair
- Stem artifact repair: Light / Balanced / Strong
- 44.1 kHz or 48 kHz conversion
- A/B preview
- Batch processing
- 24-bit WAV export to a `CUBASE_READY` folder

### Explicit non-goals for MVP

- Stem separation
- Full mastering
- Generative music editing
- Timeline editing
- Advanced manual EQ
- Suno downloading
- Cloud accounts or subscriptions
- Chat interface

## 2. Accuracy Rules

### Factual values

These come directly from the file or deterministic measurement:

- Container and codec
- Duration
- Channel count
- Sample rate
- Bit depth
- Sample peak
- True peak
- Integrated LUFS
- RMS
- DC offset
- Clipped sample count
- Stereo correlation

### Estimated values

These must always be labelled as estimates with confidence:

- Tempo
- Musical key
- Noise floor
- Artifact likelihood
- Instrument/stem type
- Recommended repair strength

A language model must not be used as the audio measurement engine. DSP and dedicated audio models perform analysis and repair. An optional reasoning layer may summarize results and recommend a visible processing chain.

## 3. Processing Pipeline

```mermaid
flowchart LR
    A["Import"] --> B["Probe"]
    B --> C["Analyze"]
    C --> D["Repair"]
    D --> E["Convert"]
    E --> F["Normalize"]
    F --> G["A/B Preview"]
    G --> H["Export"]
```

Default processing order:

1. Decode to an internal floating-point stream.
2. Correct DC offset.
3. Repair clicks and short discontinuities.
4. Apply selected stem-artifact repair.
5. Perform channel conversion when requested.
6. Resample when requested.
7. Normalize last.
8. Validate output and write a new file.

Source files are never overwritten.

## 4. Desktop Architecture

| Layer | Responsibility |
|---|---|
| Tauri 2 | Desktop shell, native dialogs, filesystem permissions, process control |
| React + TypeScript | Queue, controls, waveform, A/B state, progress |
| Rust command bridge | Typed IPC, job lifecycle, cancellation, event streaming |
| Python audio engine | Analysis, DSP orchestration, model inference |
| FFmpeg/FFprobe | Decode, encode, probing, format validation |
| Local model runtime | Dedicated artifact detection/repair where it outperforms DSP |
| JSONL events | Per-file progress and structured results |

### Separation rules

- UI configuration lives separately from audio-processing presets.
- Measurement results use a versioned JSON schema.
- Repair presets use data files, not hard-coded UI values.
- The processing engine can run headlessly for testing.
- Every job records input hash, operations, settings, output path, and errors.

## 5. Interface Wireframe

### App shell

| Region | Width | Content |
|---|---:|---|
| Track queue | 26% | Imported tracks, status, duration, selection |
| Main workspace | 74% | Drop zone or selected-track analysis and waveform |
| Tool rail | Main workspace top | Mono, Normalize, Repair, Sample Rate |
| Action bar | Bottom | A/B, Process Selected, Export |

### Empty state

- One large upload surface acts as both drop zone and browse button.
- Minimal text: **Drop Suno tracks here**.
- Supported-format note remains visually secondary.
- No settings panels appear before files are loaded.

### Loaded state

- Queue stays visible and supports multiple selection.
- The selected track shows waveform, factual measurements, and warnings.
- Tools use short labels and clear active states.
- Repair strength appears only after enabling Repair.
- Advanced values stay inside one compact disclosure.
- Processing progress appears on each queue row, not in modal dialogs.

### Interaction rules

- One click selects a track.
- Ctrl/Shift supports multi-selection.
- Space toggles playback.
- A/B never changes playback position.
- Undo restores the pending processing recipe before export.
- Closing the app during active processing requires confirmation.
- Default scrollbars stay hidden while wheel/trackpad scrolling remains functional.

## 6. Repair Modes

| Mode | Intended use | Constraint |
|---|---|---|
| Light | Mild chirps, clicks, thin edges | Preserve transients and brightness |
| Balanced | Typical separated Suno stems | Default |
| Strong | Severe watery/musical-noise artifacts | Warn about possible detail loss |

The UI must not promise full restoration. Some separation damage is irreversible.

## 7. Export Contract

Default preset: **Cubase Ready**

- WAV
- PCM 24-bit
- Original sample rate unless the user selects 44.1/48 kHz
- Preserve stereo unless Mono is selected
- Peak protection at or below -1 dBTP
- Output folder: `CUBASE_READY` beside the source
- Filename suffix describes only applied operations
- Machine-readable processing report stored separately from the audio

## 8. Delivery Phases

### Phase 0 — Product lock

- Architecture
- Wireframe
- Visual direction
- Processing contract

### Phase 1 — Stable shell

- Tauri + React project
- Import and queue
- Native file handling
- Job/event foundation
- CI, lint, build

### Phase 2 — Truthful analysis

- FFprobe metadata
- Peak, true peak, LUFS, RMS, DC offset
- Stereo correlation and clipping
- Versioned result schema

### Phase 3 — Deterministic processing

- Mono
- DC correction
- Click repair
- Resampling
- Peak/LUFS normalization
- Batch export

### Phase 4 — Stem repair

- Reference dataset
- Baseline DSP
- Model evaluation
- Light/Balanced/Strong presets
- A/B validation

### Phase 5 — Desktop release

- Cancellation and recovery
- Windows packaging
- Clean-machine verification
- Signed release readiness

## 9. Acceptance Gate for Implementation

Implementation starts only after approval of:

- Product name
- Single-window layout
- Visual direction
- Exact MVP tool set
- Default Cubase export preset
