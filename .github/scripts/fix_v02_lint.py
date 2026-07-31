from pathlib import Path

path = Path("src/App.jsx")
text = path.read_text(encoding="utf-8")

text = text.replace(
    "  const [engineStatus, setEngineStatus] = useState({ ready: false, label: 'CHECKING' })",
    "  const [engineStatus, setEngineStatus] = useState(() => isTauriRuntime() ? { ready: false, label: 'CHECKING' } : { ready: false, label: 'PREVIEW' })",
    1,
)

text = text.replace(
    "  useEffect(() => {\n    if (!isTauriRuntime()) return setEngineStatus({ ready: false, label: 'PREVIEW' })\n    checkNativeAudioEngine().then((status) => {",
    "  useEffect(() => {\n    if (!isTauriRuntime()) return undefined\n    checkNativeAudioEngine().then((status) => {",
    1,
)

old_preview = """  useEffect(() => {
    let active = true
    const previewPath = abMode === 'B' && selected.outputPath ? selected.outputPath : selected.path
    if (!previewPath || !isTauriRuntime()) { setPreviewUrl(''); setPlaying(false); setPosition(0); return () => { active = false } }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => { if (active) { setPreviewUrl(convertFileSrc(previewPath)); setPlaying(false); setPosition(0) } }).catch((error) => setNotice(error.message || 'Unable to load audio preview'))
    return () => { active = false }
  }, [selected.path, selected.outputPath, abMode])"""

new_preview = """  useEffect(() => {
    let active = true
    const previewPath = abMode === 'B' && selected.outputPath ? selected.outputPath : selected.path
    if (!previewPath || !isTauriRuntime()) {
      queueMicrotask(() => {
        if (!active) return
        setPreviewUrl('')
        setPlaying(false)
        setPosition(0)
      })
      return () => { active = false }
    }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => { if (active) { setPreviewUrl(convertFileSrc(previewPath)); setPlaying(false); setPosition(0) } }).catch((error) => setNotice(error.message || 'Unable to load audio preview'))
    return () => { active = false }
  }, [selected.path, selected.outputPath, abMode])"""

if old_preview not in text:
    raise RuntimeError("Preview effect pattern was not found")
text = text.replace(old_preview, new_preview, 1)

path.write_text(text, encoding="utf-8")
