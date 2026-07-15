# Phase 12 validation

## Scope
- Progressive multi-file import with three concurrent workers
- Duplicate prevention by normalized path or filename
- Explicit Add Tracks and Clear Queue controls
- Per-track remove action with selection recovery
- Separate Process Selected and Process All actions
- Mature queue density, empty state, and footer hierarchy

## Required gates
- ESLint
- Frontend production build
- Rust tests and checks
- Windows NSIS installer build
- Manual Windows validation with 15+ WAV files
