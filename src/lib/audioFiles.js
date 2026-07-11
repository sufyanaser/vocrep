const AUDIO_EXTENSIONS = ['wav', 'wave', 'flac', 'mp3', 'aif', 'aiff', 'm4a', 'aac', 'ogg', 'opus']

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function extensionOf(name) {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

export function isSupportedAudioName(name) {
  return AUDIO_EXTENSIONS.includes(extensionOf(name))
}

function readWavFormat(arrayBuffer) {
  const view = new DataView(arrayBuffer)
  if (view.byteLength < 36) return null
  const readFourCC = (offset) => String.fromCharCode(...Array.from({ length: 4 }, (_, index) => view.getUint8(offset + index)))
  if (readFourCC(0) !== 'RIFF' || readFourCC(8) !== 'WAVE') return null
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const chunk = readFourCC(offset)
    const chunkSize = view.getUint32(offset + 4, true)
    if (chunk === 'fmt ' && offset + 24 <= view.byteLength) {
      return {
        audioFormat: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitDepth: view.getUint16(offset + 22, true),
      }
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  return null
}

async function decodeBrowserFile(file) {
  const buffer = await file.arrayBuffer()
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) throw new Error('Web Audio is unavailable')
  const context = new AudioContextClass()
  try {
    const decoded = await context.decodeAudioData(buffer.slice(0))
    const extension = extensionOf(file.name)
    const wavFormat = extension === 'wav' || extension === 'wave' ? readWavFormat(buffer) : null
    const channels = wavFormat?.channels ?? decoded.numberOfChannels
    return {
      path: null,
      name: file.name,
      container: extension.toUpperCase(),
      codec: extension === 'wav' ? 'PCM' : extension.toUpperCase(),
      durationSeconds: decoded.duration,
      sampleRate: wavFormat?.sampleRate ?? decoded.sampleRate,
      bitDepth: wavFormat?.bitDepth ?? null,
      channels,
      channelLayout: channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} channels`,
      fileSize: file.size,
      source: 'browser',
    }
  } finally {
    await context.close()
  }
}

export async function analyzeBrowserFiles(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith('audio/') || isSupportedAudioName(file.name))
  const settled = await Promise.allSettled(files.map(decodeBrowserFile))
  const metadata = []
  const errors = []
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') metadata.push(result.value)
    else errors.push(`${files[index].name}: ${result.reason?.message ?? 'decode failed'}`)
  })
  return { metadata, errors }
}

export async function browseNativeAudioFiles() {
  if (!isTauriRuntime()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: true,
    directory: false,
    title: 'Import Suno tracks',
    filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
  })
  if (!selected) return []
  return Array.isArray(selected) ? selected : [selected]
}

export async function analyzeNativePaths(paths) {
  if (!paths?.length) return { metadata: [], errors: [] }
  const { invoke } = await import('@tauri-apps/api/core')
  const results = await invoke('probe_audio_files', { paths })
  const metadata = []
  const errors = []
  results.forEach((result, index) => {
    if (result?.Ok) metadata.push(result.Ok)
    else if (result?.ok) metadata.push(result.ok)
    else if (result?.Err || result?.err) errors.push(`${paths[index]}: ${result.Err ?? result.err}`)
    else if (result?.name) metadata.push(result)
  })
  return { metadata, errors }
}

export async function listenForNativeDrop(onPaths) {
  if (!isTauriRuntime()) return () => {}
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow().onDragDropEvent((event) => {
    if (event.payload.type === 'drop') onPaths(event.payload.paths)
  })
}


export async function processNativeAudio(paths, options) {
  if (!isTauriRuntime()) throw new Error('Audio processing requires the desktop app')
  if (!paths?.length) throw new Error('Import a local audio file first')
  const { invoke } = await import('@tauri-apps/api/core')
  const results = await invoke('process_audio_files', { paths, options })
  const completed = []
  const errors = []
  results.forEach((result, index) => {
    if (result?.Ok) completed.push(result.Ok)
    else if (result?.ok) completed.push(result.ok)
    else if (result?.Err || result?.err) errors.push(result.Err ?? result.err)
    else if (result?.outputPath) completed.push(result)
    else errors.push(paths[index] + ': processing failed')
  })
  return { completed, errors }
}


export async function checkNativeAudioEngine() {
  if (!isTauriRuntime()) return { ready: false, error: 'Desktop runtime required', missingFilters: [] }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke('check_audio_engine')
}
