# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## VocRep visual lock

- The approved source of truth is `qa/source-reference.jpg`, selected by the user on 2026-07-11.
- Preserve the single-window graphite/black studio surface with orange signal accents.
- Preserve the physical layout: track queue left, direct tool rail top, waveform center, transport and measurements below, persistent process/export actions at the bottom.
- Keep copy minimal and controls direct; do not introduce dashboard cards, decorative graphics, chat UI, or dense settings panels.

## Native data rules

- `develop` is the development source of truth.
- Native file metadata comes from the Rust `probe_audio_files` command and local FFprobe.
- Browser WAV verification must read the RIFF header; do not report the AudioContext playback rate as the source sample rate.
- Never display placeholder True Peak, LUFS, RMS, clipping, or artifact values for imported files. Use `Pending` or `—` until measured.
- Keep demo/reference tracks in `src/data/`; do not hard-code mutable track data inside UI components.
