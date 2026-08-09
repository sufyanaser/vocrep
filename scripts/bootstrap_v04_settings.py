from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly 1 match, found {count}')
    return text.replace(old, new, 1)


def patch_app() -> None:
    path = ROOT / 'src' / 'App.jsx'
    text = path.read_text(encoding='utf-8')

    text = replace_once(
        text,
        "  browseNativeAudioFiles,\n",
        "  browseNativeAudioFiles,\n  browseNativeOutputFolder,\n",
        'App import browse output folder',
    )
    text = replace_once(
        text,
        "} from './lib/audioFiles.js'\n\nconst DEFAULT_PROCESS_OPTIONS",
        "} from './lib/audioFiles.js'\nimport { SettingsModal } from './SettingsModal.jsx'\nimport { loadAppSettings, saveAppSettings } from './appSettings.js'\n\nconst DEFAULT_PROCESS_OPTIONS",
        'App settings imports',
    )
    text = replace_once(
        text,
        "export function App() {\n  const [tracks, setTracks] = useState([])\n  const [selectedId, setSelectedId] = useState(null)\n  const [defaultOptions, setDefaultOptions] = useState(() => cloneOptions())\n  const [settingsScope, setSettingsScope] = useState('all')",
        "export function App() {\n  const [tracks, setTracks] = useState([])\n  const [selectedId, setSelectedId] = useState(null)\n  const [appSettings, setAppSettings] = useState(() => loadAppSettings())\n  const [settingsOpen, setSettingsOpen] = useState(false)\n  const [defaultOptions, setDefaultOptions] = useState(() => cloneOptions({ sampleRate: appSettings.defaultSampleRate, outputDepth: appSettings.defaultOutputDepth }))\n  const [settingsScope, setSettingsScope] = useState('all')",
        'App settings state',
    )

    browse_anchor = "  const browseForTracks = useCallback(async () => {\n    if (!isTauriRuntime()) return fileInput.current?.click()\n    try { await addNativePaths(await browseNativeAudioFiles()) } catch (error) { setNotice(error.message || 'Unable to open audio files') }\n  }, [addNativePaths])\n"
    browse_insert = browse_anchor + "\n  const browseForOutputFolder = useCallback(async () => {\n    if (!isTauriRuntime()) throw new Error('Output folder selection requires the desktop app')\n    return browseNativeOutputFolder()\n  }, [])\n\n  const commitAppSettings = useCallback((nextSettings) => {\n    const normalized = saveAppSettings(nextSettings)\n    setAppSettings(normalized)\n    setDefaultOptions((current) => ({\n      ...current,\n      sampleRate: normalized.defaultSampleRate,\n      outputDepth: normalized.defaultOutputDepth,\n    }))\n    setSettingsOpen(false)\n    setNotice('SETTINGS SAVED')\n  }, [])\n"
    text = replace_once(text, browse_anchor, browse_insert, 'App settings callbacks')

    text = replace_once(
        text,
        "      if (event.code !== 'Space' || event.repeat || processing || processSession) return",
        "      if (event.code !== 'Space' || event.repeat || processing || processSession || settingsOpen) return",
        'App space guard',
    )
    text = replace_once(
        text,
        "  }, [processSession, processing, togglePlayback])",
        "  }, [processSession, processing, settingsOpen, togglePlayback])",
        'App space effect dependencies',
    )
    text = replace_once(
        text,
        "        const result = await processNativeTrack(target.path, target.options ?? defaultOptions, jobId)",
        "        const outputDirectory = appSettings.outputMode === 'custom' && appSettings.outputDirectory.trim() ? appSettings.outputDirectory.trim() : null\n        const result = await processNativeTrack(target.path, target.options ?? defaultOptions, jobId, outputDirectory, appSettings.namingMode)",
        'App processing settings',
    )
    text = replace_once(
        text,
        "    setNotice(`${completed} PROCESSED${failed ? ` · ${failed} FAILED` : ''}`)\n  }",
        "    setNotice(`${completed} PROCESSED${failed ? ` · ${failed} FAILED` : ''}`)\n    if (completed && appSettings.openOutputFolderAfterProcess && lastOutputFolder) {\n      try { await openNativeOutputFolder(lastOutputFolder) } catch (error) { setNotice(error.message || 'Unable to open output folder') }\n    }\n  }",
        'App auto open output folder',
    )
    text = replace_once(
        text,
        '<footer className="actionbar"><div className="project-info"><GearSix size={25} /><span>ENGINE <strong>{engineStatus.label}</strong></span>',
        '<footer className="actionbar"><div className="project-info"><button className="settings-button" type="button" aria-label="Open settings" title="Settings" disabled={processing} onClick={() => setSettingsOpen(true)}><GearSix size={25} /></button><span>ENGINE <strong>{engineStatus.label}</strong></span>',
        'App settings button',
    )
    text = replace_once(
        text,
        "        {processSession && <ProcessingModal session={processSession} onOpenFolder={openOutputFolder} onClose={() => { if (!processing) setProcessSession(null) }} />}\n",
        "        <SettingsModal open={settingsOpen} settings={appSettings} engineStatus={engineStatus} desktopRuntime={isTauriRuntime()} onClose={() => setSettingsOpen(false)} onSave={commitAppSettings} onBrowseOutputFolder={browseForOutputFolder} />\n        {processSession && <ProcessingModal session={processSession} onOpenFolder={openOutputFolder} onClose={() => { if (!processing) setProcessSession(null) }} />}\n",
        'App settings modal render',
    )

    path.write_text(text, encoding='utf-8')


def patch_audio_files() -> None:
    path = ROOT / 'src' / 'lib' / 'audioFiles.js'
    text = path.read_text(encoding='utf-8')

    browse_anchor = "export async function analyzeNativePaths(paths) {"
    browse_fn = "export async function browseNativeOutputFolder() {\n  if (!isTauriRuntime()) return null\n  const { open } = await import('@tauri-apps/plugin-dialog')\n  const selected = await open({\n    multiple: false,\n    directory: true,\n    title: 'Choose NAS VocRep output folder',\n  })\n  if (!selected) return null\n  return Array.isArray(selected) ? selected[0] ?? null : selected\n}\n\n"
    text = replace_once(text, browse_anchor, browse_fn + browse_anchor, 'audioFiles output folder browser')
    text = replace_once(
        text,
        "export async function processNativeTrack(path, options, jobId) {\n  if (!isTauriRuntime()) throw new Error('Audio processing requires the desktop app')\n  if (!path) throw new Error('Import a local audio file first')\n  const { invoke } = await import('@tauri-apps/api/core')\n  return invoke('process_audio_track', { path, options, jobId })\n}",
        "export async function processNativeTrack(path, options, jobId, outputDirectory = null, namingMode = 'detailed') {\n  if (!isTauriRuntime()) throw new Error('Audio processing requires the desktop app')\n  if (!path) throw new Error('Import a local audio file first')\n  const { invoke } = await import('@tauri-apps/api/core')\n  return invoke('process_audio_track', { path, options, jobId, outputDirectory, namingMode })\n}",
        'audioFiles process settings',
    )
    path.write_text(text, encoding='utf-8')


def patch_rust() -> None:
    path = ROOT / 'src-tauri' / 'src' / 'lib.rs'
    text = path.read_text(encoding='utf-8')

    output_pattern = re.compile(r"fn output_path_for\(input: &Path, options: &ProcessOptions\) -> Result<PathBuf, String> \{.*?\n\}\n\nfn prepare_processing", re.S)
    output_replacement = '''fn output_path_for(
    input: &Path,
    options: &ProcessOptions,
    output_directory: Option<&str>,
    naming_mode: &str,
) -> Result<PathBuf, String> {
    let parent = input
        .parent()
        .ok_or_else(|| "Input file has no parent folder".to_string())?;
    let output_dir = match output_directory.map(str::trim).filter(|value| !value.is_empty()) {
        Some(directory) => PathBuf::from(directory),
        None => parent.join("CUBASE_READY"),
    };
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Unable to create output folder: {error}"))?;
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("track");
    let channel = channel_suffix(&options.channel_mode)?;
    let rate = rate_suffix(options.sample_rate);
    let file_name = match naming_mode {
        "compact" => format!("{stem}_Ready{channel}{rate}.wav"),
        "detailed" | "" => {
            let depth = depth_suffix(options.output_depth);
            let enhancements = enhancement_suffix(options);
            format!("{stem}_Ready{channel}{rate}{depth}{enhancements}.wav")
        }
        other => return Err(format!("Unsupported naming mode: {other}")),
    };
    Ok(output_dir.join(file_name))
}

fn prepare_processing'''
    text, count = output_pattern.subn(output_replacement, text, count=1)
    if count != 1:
        raise RuntimeError(f'Rust output_path_for: expected 1 match, found {count}')

    text = replace_once(
        text,
        "fn prepare_processing(\n    path: &str,\n    options: &ProcessOptions,\n) -> Result<(PathBuf, PathBuf, AudioMetadata), String> {",
        "fn prepare_processing(\n    path: &str,\n    options: &ProcessOptions,\n    output_directory: Option<&str>,\n    naming_mode: &str,\n) -> Result<(PathBuf, PathBuf, AudioMetadata), String> {",
        'Rust prepare processing signature',
    )
    text = replace_once(
        text,
        "    let output = output_path_for(&input, options)?;",
        "    let output = output_path_for(&input, options, output_directory, naming_mode)?;",
        'Rust prepare output call',
    )
    text = replace_once(
        text,
        "fn process_audio_track_blocking(\n    app: tauri::AppHandle,\n    job_id: String,\n    path: String,\n    options: ProcessOptions,\n) -> Result<ProcessedTrackResult, String> {",
        "fn process_audio_track_blocking(\n    app: tauri::AppHandle,\n    job_id: String,\n    path: String,\n    options: ProcessOptions,\n    output_directory: Option<String>,\n    naming_mode: String,\n) -> Result<ProcessedTrackResult, String> {",
        'Rust blocking processing signature',
    )
    text = replace_once(
        text,
        "    let (input, output, source_metadata) = match prepare_processing(&path, &options) {",
        "    let (input, output, source_metadata) = match prepare_processing(&path, &options, output_directory.as_deref(), &naming_mode) {",
        'Rust blocking prepare call',
    )
    text = replace_once(
        text,
        "async fn process_audio_track(\n    app: tauri::AppHandle,\n    job_id: String,\n    path: String,\n    options: ProcessOptions,\n) -> Result<ProcessedTrackResult, String> {\n    tauri::async_runtime::spawn_blocking(move || {\n        process_audio_track_blocking(app, job_id, path, options)\n    })",
        "async fn process_audio_track(\n    app: tauri::AppHandle,\n    job_id: String,\n    path: String,\n    options: ProcessOptions,\n    output_directory: Option<String>,\n    naming_mode: Option<String>,\n) -> Result<ProcessedTrackResult, String> {\n    tauri::async_runtime::spawn_blocking(move || {\n        process_audio_track_blocking(\n            app,\n            job_id,\n            path,\n            options,\n            output_directory,\n            naming_mode.unwrap_or_else(|| \"detailed\".to_string()),\n        )\n    })",
        'Rust async processing settings',
    )
    text = text.replace(
        'output_path_for(Path::new("/tmp/Song01 Vocal.wav"), &test_options()).unwrap()',
        'output_path_for(Path::new("/tmp/Song01 Vocal.wav"), &test_options(), None, "detailed").unwrap()',
    )
    text = text.replace(
        'output_path_for(Path::new("/tmp/Song01.wav"), &options).unwrap()',
        'output_path_for(Path::new("/tmp/Song01.wav"), &options, None, "detailed").unwrap()',
    )
    test_anchor = '''    #[test]
    fn parses_pcm_wave_metadata() {'''
    compact_test = '''    #[test]
    fn creates_compact_output_name() {
        let output = output_path_for(
            Path::new("/tmp/Song01 Vocal.wav"),
            &test_options(),
            None,
            "compact",
        )
        .unwrap();
        assert!(output.ends_with("CUBASE_READY/Song01 Vocal_Ready_Mono_48k.wav"));
    }

'''
    text = replace_once(text, test_anchor, compact_test + test_anchor, 'Rust compact naming test')

    path.write_text(text, encoding='utf-8')


def main() -> None:
    patch_app()
    patch_audio_files()
    patch_rust()
    print('V04 settings patch applied successfully')


if __name__ == '__main__':
    main()
