import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowsLeftRight, Check, DownloadSimple, FolderOpen, GearSix, Pause, Play, Plus,
  SkipBack, SkipForward, SpeakerSimpleHigh, Stop, Trash, X,
  Waveform as WaveformIcon, Wrench,
} from '@phosphor-icons/react'
import {
  analyzeBrowserFiles,
  analyzeNativePaths,
  browseNativeAudioFiles,
  browseNativeOutputFolder,
  checkNativeAudioEngine,
  formatDuration,
  getNativeWaveform,
  isTauriRuntime,
  listenForNativeDrop,
  listenForProcessingStages,
  openNativeOutputFolder,
  processNativeTrack,
} from './lib/audioFiles.js'
import { SettingsModal } from './SettingsModal.jsx'
import { loadAppSettings, saveAppSettings } from './appSettings.js'

const DEFAULT_PROCESS_OPTIONS = Object.freeze({
  channelMode: 'Keep Stereo',
  normalize: false,
  targetLufs: -16,
  subBassCut: false,
  deHarshness: false,
  enableMicroFades: false,
  deClickMode: 'Off',
  noiseCleanupMode: 'Off',
  sampleRate: 48000,
  outputDepth: 24,
})

const FACTORY_PRESETS = Object.freeze([
  {
    id: 'vocal-clean',
    label: 'Vocal Stem Clean',
    options: Object.freeze({
      ...DEFAULT_PROCESS_OPTIONS,
      normalize: true,
      targetLufs: -16,
      subBassCut: true,
      deHarshness: true,
    }),
  },
  {
    id: 'bass-kick',
    label: 'Bass / Kick Sub-Fix',
    options: Object.freeze({
      ...DEFAULT_PROCESS_OPTIONS,
      normalize: true,
      targetLufs: -14,
      subBassCut: true,
    }),
  },
  {
    id: 'smooth',
    label: 'Acoustic & Synth Smooth',
    options: Object.freeze({
      ...DEFAULT_PROCESS_OPTIONS,
      normalize: true,
      targetLufs: -16,
      subBassCut: true,
      deHarshness: true,
    }),
  },
  {
    id: 'bypass',
    label: 'Bypass / Raw Conversion',
    options: DEFAULT_PROCESS_OPTIONS,
  },
])

const PROCESS_STAGES = [
  { id: 'preparing', label: 'PREPARING', detail: 'Validating the source and output settings' },
  { id: 'processing', label: 'PROCESSING AUDIO', detail: 'Running the selected FFmpeg operations' },
  { id: 'analyzing', label: 'ANALYZING OUTPUT', detail: 'Measuring metadata, LUFS, and True Peak' },
  { id: 'preview', label: 'BUILDING PREVIEW', detail: 'Generating the processed waveform' },
  { id: 'complete', label: 'COMPLETE', detail: 'The output is ready for A/B preview' },
]

const STAGE_PROGRESS = {
  preparing: 15,
  processing: 45,
  analyzing: 72,
  preview: 90,
  complete: 100,
}

const FINAL_PROCESS_STATUSES = new Set(['complete', 'complete-with-errors', 'error'])

function cloneOptions(options = DEFAULT_PROCESS_OPTIONS) {
  return { ...DEFAULT_PROCESS_OPTIONS, ...options }
}

function optionsEqual(left, right) {
  return Object.keys(DEFAULT_PROCESS_OPTIONS).every((key) => left?.[key] === right?.[key])
}

function presetIdForOptions(options) {
  return FACTORY_PRESETS.find((preset) => optionsEqual(options, preset.options))?.id ?? 'custom'
}

function compactSampleRate(value) {
  if (!value) return '—'
  const kiloHertz = value / 1000
  return `${Number.isInteger(kiloHertz) ? kiloHertz : kiloHertz.toFixed(1)} kHz`
}

function clockLabel(seconds, milliseconds = false) {
  if (!Number.isFinite(seconds) || seconds < 0) return milliseconds ? '00:00.000' : '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  const fraction = milliseconds ? `.${String(Math.floor((seconds % 1) * 1000)).padStart(3, '0')}` : ''
  return `${milliseconds ? String(minutes).padStart(2, '0') : minutes}:${String(remainder).padStart(2, '0')}${fraction}`
}

function trackFromMetadata(metadata, index = 0, options = DEFAULT_PROCESS_OPTIONS) {
  const rawLayout = metadata.channelLayout || `${metadata.channels || 0} channels`
  return {
    id: `${Date.now()}-${index}-${metadata.path ?? metadata.name}`,
    name: metadata.name,
    path: metadata.path,
    duration: formatDuration(metadata.durationSeconds),
    durationSeconds: metadata.durationSeconds,
    state: 'ready',
    progress: 0,
    container: metadata.container || 'UNKNOWN',
    codec: metadata.codec || 'Unknown codec',
    sampleRateHz: metadata.sampleRate || 0,
    bitDepth: metadata.bitDepth,
    channels: metadata.channels || 0,
    channelLayout: `${rawLayout.charAt(0).toUpperCase()}${rawLayout.slice(1)}`,
    fileSize: metadata.fileSize || 0,
    metadataSource: metadata.source,
    truePeak: Number.isFinite(metadata.truePeakDbtp) ? `${metadata.truePeakDbtp.toFixed(1)} dBTP` : null,
    lufs: Number.isFinite(metadata.integratedLufs) ? `${metadata.integratedLufs.toFixed(1)} LUFS` : null,
    waveform: metadata.waveform || null,
    options: cloneOptions(options),
    error: null,
  }
}

function Waveform({ playing, position, peaks, channels, onSeek }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const context = canvas.getContext('2d')
    const draw = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, rect.width, rect.height)
      context.strokeStyle = 'rgba(255,255,255,.055)'
      context.lineWidth = 1
      for (let y = 26; y < rect.height; y += 52) {
        context.beginPath()
        context.moveTo(0, y + 0.5)
        context.lineTo(rect.width, y + 0.5)
        context.stroke()
      }
      const visibleChannels = Math.max(1, Math.min(channels || peaks?.length || 1, peaks?.length || 1))
      const gap = visibleChannels > 1 ? 30 : 0
      const channelHeight = (rect.height - gap * (visibleChannels - 1)) / visibleChannels
      const bars = peaks?.[0]?.length || 0
      const step = bars ? rect.width / bars : 0
      context.strokeStyle = '#ff9d18'
      context.lineWidth = Math.max(1, step * 0.56)
      if (bars) {
        Array.from({ length: visibleChannels }, (_, channel) => channel).forEach((channel) => {
          const center = channel * (channelHeight + gap) + channelHeight / 2
          for (let index = 0; index < bars; index += 1) {
            const amplitude = Math.min(1, peaks[channel]?.[index] || 0) * channelHeight * 0.43
            const x = index * step + step / 2
            context.beginPath()
            context.moveTo(x, center - amplitude)
            context.lineTo(x, center + amplitude)
            context.stroke()
          }
        })
      }
      const playheadX = rect.width * position
      context.strokeStyle = playing ? '#ffd071' : '#ff8a00'
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(playheadX + 0.5, 0)
      context.lineTo(playheadX + 0.5, rect.height)
      context.stroke()
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [playing, position, peaks, channels])

  return <canvas ref={canvasRef} className="waveform-canvas" aria-label={`${channels === 1 ? 'Mono' : 'Stereo'} waveform preview`} onClick={(event) => onSeek?.(event.nativeEvent.offsetX / event.currentTarget.clientWidth)} />
}

function Toggle({ checked, onChange, label, disabled = false }) {
  return <button className={`toggle ${checked ? 'is-on' : ''}`} type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
}

function Tool({ icon, title, children }) {
  return <section className="tool"><div className="tool-heading">{icon}<span>{title}</span></div>{children}</section>
}

function TrackRow({ track, index, selected, custom, disabled, onSelect, onRemove }) {
  const statusLabel = track.state === 'processing'
    ? 'PROCESSING'
    : track.state === 'complete'
      ? 'COMPLETE'
      : track.state === 'failed'
        ? 'FAILED'
        : 'READY'
  return (
    <div className={`track-row ${selected ? 'selected' : ''}`} role="button" tabIndex={0} onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect() }}>
      <span className="track-number">{index + 1}</span>
      <Play className="track-play" weight="fill" />
      <span className="track-main">
        <span className="track-title-line"><span className="track-name">{track.name}</span>{custom && <b className="custom-badge">CUSTOM</b>}</span>
        <span className="track-meta">{track.container} · {compactSampleRate(track.sampleRateHz)} · {track.bitDepth ? `${track.bitDepth}-bit` : '—'} · {track.duration}</span>
        <span className="track-progress"><i style={{ width: `${track.progress}%` }} /></span>
      </span>
      <span className={`track-state ${track.state}`}>{track.state === 'complete' ? <Check weight="bold" /> : statusLabel}</span>
      <button className="track-remove" type="button" aria-label={`Remove ${track.name}`} disabled={disabled} onClick={(event) => { event.stopPropagation(); onRemove() }}><X weight="bold" /></button>
    </div>
  )
}

function ProcessingModal({ session, onClose, onOpenFolder }) {
  const currentIndex = Math.max(0, PROCESS_STAGES.findIndex((stage) => stage.id === session.stage))
  const isFinal = FINAL_PROCESS_STATUSES.has(session.status)
  const remaining = Math.max(0, session.totalTracks - session.completed - session.failed)
  const title = session.status === 'complete'
    ? 'PROCESSING COMPLETE'
    : session.status === 'error'
      ? 'PROCESSING FAILED'
      : session.status === 'complete-with-errors'
        ? 'COMPLETE WITH ERRORS'
        : 'PROCESSING TRACKS'

  return (
    <div className="processing-overlay" role="dialog" aria-modal="true" aria-labelledby="processing-title">
      <section className={`processing-modal status-${session.status}`} aria-live="polite">
        <header className="processing-header">
          <div>
            <span className="processing-kicker">NAS VOCREP V04</span>
            <h2 id="processing-title">{title}</h2>
          </div>
          <span className="processing-counter">TRACK {session.trackIndex} / {session.totalTracks}</span>
        </header>

        <div className="processing-track">
          <span>CURRENT TRACK</span>
          <strong title={session.trackName}>{session.trackName}</strong>
        </div>

        <ol className="processing-stages">
          {PROCESS_STAGES.map((stage, index) => {
            const isDone = session.status === 'complete'
              || session.stage === 'complete'
              || index < currentIndex
              || (index === currentIndex && session.stageStatus === 'done')
            const isError = Boolean(session.error) && index === currentIndex && session.stageStatus === 'error'
            const isActive = !isFinal && !isError && index === currentIndex && session.stageStatus !== 'done'
            const stateClass = isDone ? 'is-done' : isError ? 'is-error' : isActive ? 'is-active' : 'is-pending'
            return (
              <li className={stateClass} key={stage.id}>
                <span className="stage-marker">
                  {isDone ? <Check weight="bold" /> : isError ? <X weight="bold" /> : isActive ? <i /> : <b>{index + 1}</b>}
                </span>
                <span className="stage-copy">
                  <strong>{stage.label}</strong>
                  <small>{stage.detail}</small>
                </span>
              </li>
            )
          })}
        </ol>

        <div className="processing-totals">
          <div><span>COMPLETED</span><strong>{session.completed}</strong></div>
          <div><span>FAILED</span><strong className={session.failed ? 'has-failures' : ''}>{session.failed}</strong></div>
          <div><span>REMAINING</span><strong>{remaining}</strong></div>
        </div>

        {session.error && <div className="processing-error" role="alert">{session.error}</div>}

        {isFinal && (
          <div className="processing-actions">
            {session.outputFolder && <button className="processing-folder" type="button" onClick={onOpenFolder}><FolderOpen weight="bold" />OPEN OUTPUT FOLDER</button>}
            <button className="processing-close" type="button" onClick={onClose}>CLOSE</button>
          </div>
        )}
      </section>
    </div>
  )
}

export function App() {
  const [tracks, setTracks] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [appSettings, setAppSettings] = useState(() => loadAppSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [defaultOptions, setDefaultOptions] = useState(() => cloneOptions({ sampleRate: appSettings.defaultSampleRate, outputDepth: appSettings.defaultOutputDepth }))
  const [settingsScope, setSettingsScope] = useState('all')
  const [playing, setPlaying] = useState(false)
  const [abMode, setAbMode] = useState('A')
  const [position, setPosition] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [processSession, setProcessSession] = useState(null)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [engineStatus, setEngineStatus] = useState(() => isTauriRuntime() ? { ready: false, label: 'CHECKING' } : { ready: false, label: 'PREVIEW' })
  const fileInput = useRef(null)
  const audioRef = useRef(null)
  const abSeekRef = useRef(null)
  const jobTrackMapRef = useRef(new Map())
  const emptyTrack = useMemo(() => ({ name: 'No track selected', codec: '', container: '—', sampleRateHz: 0, bitDepth: null, channelLayout: '—', truePeak: null, lufs: null, options: defaultOptions }), [defaultOptions])
  const selected = useMemo(() => tracks.find((track) => track.id === selectedId) ?? tracks[0] ?? emptyTrack, [tracks, selectedId, emptyTrack])
  const editingOptions = settingsScope === 'all' ? defaultOptions : selected.options ?? defaultOptions
  const activePresetId = presetIdForOptions(editingOptions)
  const controlsDisabled = processing || importing || (settingsScope === 'selected' && !selected.id)
  const [previewUrl, setPreviewUrl] = useState('')
  const previewWaveform = abMode === 'B' && selected.outputWaveform ? selected.outputWaveform : selected.waveform
  const previewChannels = abMode === 'B' && selected.outputChannels ? selected.outputChannels : selected.channels
  const activeMetadata = abMode === 'B' && selected.outputMetadata ? {
    ...selected,
    container: selected.outputMetadata.container,
    codec: selected.outputMetadata.codec,
    sampleRateHz: selected.outputMetadata.sampleRate,
    bitDepth: selected.outputMetadata.bitDepth,
    channelLayout: selected.outputMetadata.channelLayout,
    channels: selected.outputMetadata.channels,
    truePeak: Number.isFinite(selected.outputMetadata.truePeakDbtp) ? `${selected.outputMetadata.truePeakDbtp.toFixed(1)} dBTP` : null,
    lufs: Number.isFinite(selected.outputMetadata.integratedLufs) ? `${selected.outputMetadata.integratedLufs.toFixed(1)} LUFS` : null,
  } : selected
  const duration = activeMetadata.durationSeconds || selected.durationSeconds || 0
  const currentSeconds = position * duration
  const timelineLabels = Array.from({ length: 8 }, (_, index) => clockLabel(duration * index / 7))

  const appendMetadata = useCallback(({ metadata, errors }, selectFirst = true) => {
    if (!metadata.length) {
      if (errors.length) setNotice(errors[0])
      return 0
    }
    let firstId = null
    let addedCount = 0
    setTracks((current) => {
      const keys = new Set(current.map((track) => (track.path || track.name).toLowerCase()))
      const additions = metadata.flatMap((item, index) => {
        const key = (item.path || item.name).toLowerCase()
        if (keys.has(key)) return []
        keys.add(key)
        const track = trackFromMetadata(item, index, defaultOptions)
        firstId ??= track.id
        addedCount += 1
        return [track]
      })
      return [...current, ...additions]
    })
    if (selectFirst && firstId) setSelectedId(firstId)
    return addedCount
  }, [defaultOptions])

  const addNativePaths = useCallback(async (paths) => {
    if (!paths?.length || importing) return
    setImporting(true)
    setNotice(`IMPORTING 0 / ${paths.length}`)
    let imported = 0
    let failed = 0
    let cursor = 0
    const workers = Array.from({ length: Math.min(3, paths.length) }, async () => {
      while (cursor < paths.length) {
        const index = cursor
        cursor += 1
        try {
          const result = await analyzeNativePaths([paths[index]])
          imported += appendMetadata(result, imported === 0)
          failed += result.errors.length
        } catch {
          failed += 1
        }
        setNotice(`IMPORTING ${index + 1} / ${paths.length}`)
      }
    })
    await Promise.all(workers)
    setImporting(false)
    setNotice(`${imported} ADDED${failed ? ` · ${failed} FAILED` : ''}`)
  }, [appendMetadata, importing])

  const addFiles = useCallback(async (fileList) => {
    if (!fileList?.length || importing) return
    setImporting(true)
    setNotice(`ANALYZING ${fileList.length} TRACKS`)
    try {
      const result = await analyzeBrowserFiles(fileList)
      const added = appendMetadata(result)
      setNotice(`${added} ADDED${result.errors.length ? ` · ${result.errors.length} FAILED` : ''}`)
    } catch (error) {
      setNotice(error.message || 'Audio analysis failed')
    } finally {
      setImporting(false)
    }
  }, [appendMetadata, importing])

  const browseForTracks = useCallback(async () => {
    if (!isTauriRuntime()) return fileInput.current?.click()
    try { await addNativePaths(await browseNativeAudioFiles()) } catch (error) { setNotice(error.message || 'Unable to open audio files') }
  }, [addNativePaths])

  const browseForOutputFolder = useCallback(async () => {
    if (!isTauriRuntime()) throw new Error('Output folder selection requires the desktop app')
    return browseNativeOutputFolder()
  }, [])

  const commitAppSettings = useCallback((nextSettings) => {
    const normalized = saveAppSettings(nextSettings)
    setAppSettings(normalized)
    setDefaultOptions((current) => ({
      ...current,
      sampleRate: normalized.defaultSampleRate,
      outputDepth: normalized.defaultOutputDepth,
    }))
    setSettingsOpen(false)
    setNotice('SETTINGS SAVED')
  }, [])

  const selectTrack = useCallback((id) => {
    if (processing) return
    abSeekRef.current = 0
    setSelectedId(id)
    setAbMode('A')
    setPosition(0)
  }, [processing])

  const removeTrack = useCallback((id) => {
    if (processing) return
    setTracks((current) => {
      const index = current.findIndex((track) => track.id === id)
      const next = current.filter((track) => track.id !== id)
      if (id === selectedId) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null)
      return next
    })
  }, [processing, selectedId])

  const clearQueue = useCallback(() => {
    if (processing) return
    setTracks([])
    setSelectedId(null)
    setAbMode('A')
    setPosition(0)
    setNotice('QUEUE CLEARED')
  }, [processing])

  const applyOption = useCallback((patch) => {
    if (processing || importing) return
    if (settingsScope === 'all') {
      setDefaultOptions((current) => ({ ...current, ...patch }))
      setTracks((current) => current.map((track) => ({ ...track, options: { ...track.options, ...patch } })))
      return
    }
    if (!selected.id) return
    setTracks((current) => current.map((track) => track.id === selected.id ? { ...track, options: { ...track.options, ...patch } } : track))
  }, [importing, processing, selected.id, settingsScope])

  const applyPreset = useCallback((presetId) => {
    const preset = FACTORY_PRESETS.find((candidate) => candidate.id === presetId)
    if (preset) applyOption(cloneOptions(preset.options))
  }, [applyOption])

  useEffect(() => {
    if (!isTauriRuntime()) return undefined
    checkNativeAudioEngine().then((status) => {
      setEngineStatus({ ready: status.ready, label: status.ready ? 'READY' : 'MISSING' })
      if (!status.ready) setNotice(status.error || 'FFmpeg engine is incomplete')
    }).catch((error) => { setEngineStatus({ ready: false, label: 'ERROR' }); setNotice(error.message || 'Audio engine check failed') })
  }, [])

  useEffect(() => {
    let unlisten = () => {}
    let mounted = true
    listenForNativeDrop(addNativePaths).then((cleanup) => { if (mounted) unlisten = cleanup; else cleanup() }).catch((error) => setNotice(error.message || 'Native drop listener failed'))
    return () => { mounted = false; unlisten() }
  }, [addNativePaths])

  useEffect(() => {
    let unlisten = () => {}
    let mounted = true
    listenForProcessingStages((payload) => {
      if (!mounted || !payload?.jobId) return
      const trackId = jobTrackMapRef.current.get(payload.jobId)
      if (trackId) {
        setTracks((current) => current.map((track) => track.id === trackId ? {
          ...track,
          state: payload.status === 'error' ? 'failed' : 'processing',
          progress: payload.status === 'error' ? track.progress : STAGE_PROGRESS[payload.stage] ?? track.progress,
          error: payload.status === 'error' ? payload.message || 'Processing failed' : null,
        } : track))
      }
      setProcessSession((current) => current?.jobId === payload.jobId ? {
        ...current,
        stage: payload.stage,
        stageStatus: payload.status,
        error: payload.status === 'error' ? payload.message || 'Processing failed' : null,
      } : current)
    }).then((cleanup) => { if (mounted) unlisten = cleanup; else cleanup() }).catch((error) => setNotice(error.message || 'Unable to monitor processing stages'))
    return () => { mounted = false; unlisten() }
  }, [])

  useEffect(() => {
    const path = abMode === 'B' && selected.outputPath ? selected.outputPath : selected.path
    if (!path || previewWaveform || !isTauriRuntime()) return undefined
    let active = true
    getNativeWaveform(path).then((data) => {
      if (!active || !data?.peaks) return
      setTracks((current) => current.map((track) => track.id === selected.id ? (abMode === 'B' ? { ...track, outputWaveform: data.peaks, outputChannels: data.channels } : { ...track, waveform: data.peaks, channels: data.channels }) : track))
    }).catch((error) => setNotice(error.message || 'Unable to extract waveform'))
    return () => { active = false }
  }, [selected.id, selected.path, selected.outputPath, previewWaveform, abMode])

  useEffect(() => {
    let active = true
    const previewPath = abMode === 'B' && selected.outputPath ? selected.outputPath : selected.path
    if (!previewPath || !isTauriRuntime()) {
      queueMicrotask(() => {
        if (!active) return
        setPreviewUrl('')
        setPlaying(false)
      })
      return () => { active = false }
    }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      if (!active) return
      setPreviewUrl(convertFileSrc(previewPath))
      setPlaying(false)
    }).catch((error) => setNotice(error.message || 'Unable to load audio preview'))
    return () => { active = false }
  }, [selected.path, selected.outputPath, abMode])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current
    if (!audio || !previewUrl) return setNotice('SELECT AN IMPORTED TRACK')
    if (audio.paused) {
      try { await audio.play() } catch (error) { setNotice(error.message || 'Playback failed') }
    } else {
      audio.pause()
    }
  }, [previewUrl])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.code !== 'Space' || event.repeat || processing || processSession || settingsOpen) return
      const target = event.target
      if (target instanceof HTMLElement && (target.matches('input, select, textarea, button, [role="button"]') || target.isContentEditable)) return
      event.preventDefault()
      void togglePlayback()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [processSession, processing, settingsOpen, togglePlayback])

  const changeAbMode = useCallback((mode) => {
    if (mode === 'B' && !selected.outputPath) return setNotice('PROCESS THIS TRACK TO ENABLE B')
    const audio = audioRef.current
    abSeekRef.current = audio?.duration ? audio.currentTime / audio.duration : position
    setAbMode(mode)
  }, [position, selected.outputPath])

  const openOutputFolder = useCallback(async () => {
    const folder = processSession?.outputFolder || selected.outputFolder
    if (!folder) return setNotice('NO OUTPUT FOLDER IS AVAILABLE')
    try { await openNativeOutputFolder(folder) } catch (error) { setNotice(error.message || 'Unable to open output folder') }
  }, [processSession?.outputFolder, selected.outputFolder])

  const processTracks = async (targets) => {
    if (processing) return
    if (!engineStatus.ready) return setNotice('FFMPEG ENGINE IS NOT READY')
    const nativeTargets = targets.filter((track) => track.path)
    if (!nativeTargets.length) return setNotice('IMPORT LOCAL TRACKS FIRST')
    const totalTracks = nativeTargets.length
    setProcessing(true)
    let completed = 0
    let failed = 0
    let lastOutputFolder = ''

    for (let index = 0; index < nativeTargets.length; index += 1) {
      const target = nativeTargets[index]
      const jobId = `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`
      jobTrackMapRef.current.set(jobId, target.id)
      setSelectedId(target.id)
      setProcessSession({
        jobId,
        trackId: target.id,
        status: 'running',
        stage: 'preparing',
        stageStatus: 'active',
        trackIndex: index + 1,
        totalTracks,
        trackName: target.name,
        completed,
        failed,
        error: null,
        outputFolder: lastOutputFolder,
      })
      setTracks((current) => current.map((track) => track.id === target.id ? { ...track, state: 'processing', progress: STAGE_PROGRESS.preparing, error: null } : track))

      try {
        const outputDirectory = appSettings.outputMode === 'custom' && appSettings.outputDirectory.trim() ? appSettings.outputDirectory.trim() : null
        const result = await processNativeTrack(target.path, target.options ?? defaultOptions, jobId, outputDirectory, appSettings.namingMode)
        completed += 1
        lastOutputFolder = result.outputFolder || lastOutputFolder
        setTracks((current) => current.map((track) => track.id === target.id ? {
          ...track,
          state: 'complete',
          progress: 100,
          outputPath: result.outputPath,
          outputFolder: result.outputFolder,
          outputWaveform: result.waveform?.peaks || null,
          outputChannels: result.metadata?.channels || result.waveform?.channels || track.channels,
          outputMetadata: result.metadata,
          error: null,
        } : track))
        setProcessSession((current) => ({ ...current, stage: 'complete', stageStatus: 'done', completed, failed, outputFolder: lastOutputFolder }))
      } catch (error) {
        failed += 1
        const message = error.message || String(error) || 'Processing failed'
        setTracks((current) => current.map((track) => track.id === target.id ? { ...track, state: 'failed', error: message } : track))
        setProcessSession((current) => ({ ...current, status: 'track-error', stageStatus: 'error', completed, failed, error: message }))
      } finally {
        jobTrackMapRef.current.delete(jobId)
      }
    }

    setProcessing(false)
    if (completed) setAbMode('B')
    setProcessSession((current) => ({
      ...current,
      status: failed ? (completed ? 'complete-with-errors' : 'error') : 'complete',
      stage: failed && !completed ? current?.stage ?? 'preparing' : 'complete',
      stageStatus: failed && !completed ? 'error' : 'done',
      trackIndex: totalTracks,
      totalTracks,
      trackName: failed && !completed ? current?.trackName ?? 'Processing failed' : failed ? 'Batch finished with errors' : 'All tracks are ready',
      completed,
      failed,
      outputFolder: lastOutputFolder,
      error: failed ? current?.error ?? `${failed} track${failed === 1 ? '' : 's'} failed` : null,
    }))
    setNotice(`${completed} PROCESSED${failed ? ` · ${failed} FAILED` : ''}`)
    if (completed && appSettings.openOutputFolderAfterProcess && lastOutputFolder) {
      try { await openNativeOutputFolder(lastOutputFolder) } catch (error) { setNotice(error.message || 'Unable to open output folder') }
    }
  }

  return (
    <main className={`app-shell ${importing ? 'is-importing' : ''}`}>
      <audio
        ref={audioRef}
        src={previewUrl}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const ratio = abSeekRef.current
          if (Number.isFinite(ratio) && event.currentTarget.duration) {
            event.currentTarget.currentTime = ratio * event.currentTarget.duration
            setPosition(ratio)
          }
          abSeekRef.current = null
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => { const audio = event.currentTarget; setPosition(audio.duration ? audio.currentTime / audio.duration : 0) }}
      />
      <div className="drop-surface" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files) }}>
        <input ref={fileInput} className="visually-hidden" type="file" multiple accept="audio/*,.wav,.wave,.flac,.mp3,.m4a,.aac,.ogg,.opus,.aif,.aiff" onChange={(event) => { addFiles(event.target.files); event.target.value = '' }} />
        <header className="brandbar"><strong>NAS <em>VocRep</em></strong><span>SUNO STEM PREPARATION</span><b>V04</b></header>
        <aside className="queue-panel">
          <div className="queue-heading"><div><span>TRACK QUEUE</span><b>{tracks.length}</b></div><div className="queue-actions"><button type="button" onClick={browseForTracks} disabled={importing || processing}><Plus weight="bold" /> ADD TRACKS</button><button className="icon-action" type="button" aria-label="Clear queue" title="Clear queue" onClick={clearQueue} disabled={!tracks.length || processing}><Trash /></button></div></div>
          <div className="track-list">{tracks.length ? tracks.map((track, index) => <TrackRow key={track.id} track={track} index={index} selected={track.id === selectedId} custom={!optionsEqual(track.options, defaultOptions)} disabled={processing} onSelect={() => selectTrack(track.id)} onRemove={() => removeTrack(track.id)} />) : <div className="queue-empty"><Plus /><strong>ADD AUDIO TRACKS</strong><span>Drop multiple files or browse from disk</span><button type="button" onClick={browseForTracks}>BROWSE FILES</button></div>}</div>
        </aside>
        <section className="workspace">
          <div className="scopebar">
            <div><span>APPLY CHANGES TO</span><strong>{settingsScope === 'all' ? 'All current tracks and new imports' : selected.name}</strong></div>
            <div className="scope-switch">
              <button type="button" className={settingsScope === 'selected' ? 'active' : ''} disabled={!tracks.length || processing} onClick={() => setSettingsScope('selected')}>SELECTED TRACK</button>
              <button type="button" className={settingsScope === 'all' ? 'active' : ''} disabled={processing} onClick={() => setSettingsScope('all')}>ALL TRACKS</button>
            </div>
          </div>
          <div className="tools-row">
            <Tool title="Preset" icon={<GearSix />}><select value={activePresetId} disabled={controlsDisabled} onChange={(event) => event.target.value !== 'custom' && applyPreset(event.target.value)} aria-label="Factory preset"><option value="custom">Custom</option>{FACTORY_PRESETS.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}</select></Tool>
            <Tool title="Channel" icon={<ArrowsLeftRight />}><select value={editingOptions.channelMode} disabled={controlsDisabled} onChange={(event) => applyOption({ channelMode: event.target.value })} aria-label="Channel mode"><option>Keep Stereo</option><option>Mono Sum</option><option>Left Channel</option><option>Right Channel</option></select></Tool>
            <Tool title="Subsonic 25 Hz" icon={<SpeakerSimpleHigh />}><Toggle checked={editingOptions.subBassCut} disabled={controlsDisabled} onChange={(value) => applyOption({ subBassCut: value })} label="Subsonic 25 Hz cut" /></Tool>
            <Tool title="De-Harsh 12 kHz" icon={<WaveformIcon />}><Toggle checked={editingOptions.deHarshness} disabled={controlsDisabled} onChange={(value) => applyOption({ deHarshness: value })} label="De-Harsh 12 kHz" /></Tool>
            <Tool title="Micro Fades" icon={<Wrench />}><Toggle checked={editingOptions.enableMicroFades} disabled={controlsDisabled} onChange={(value) => applyOption({ enableMicroFades: value })} label="5 millisecond micro fades" /></Tool>
            <Tool title="Loudness" icon={<WaveformIcon />}><select value={editingOptions.normalize ? String(editingOptions.targetLufs ?? -16) : 'off'} disabled={controlsDisabled} onChange={(event) => applyOption(event.target.value === 'off' ? { normalize: false } : { normalize: true, targetLufs: Number(event.target.value) })} aria-label="Target loudness"><option value="off">Off</option><option value="-14">-14 LUFS</option><option value="-16">-16 LUFS</option><option value="-18">-18 LUFS</option></select></Tool>
            <Tool title="De-Click" icon={<Wrench />}><select value={editingOptions.deClickMode} disabled={controlsDisabled} onChange={(event) => applyOption({ deClickMode: event.target.value })} aria-label="De-Click"><option>Off</option><option>Light</option><option>Balanced</option><option>Strong</option></select></Tool>
            <Tool title="Noise Cleanup" icon={<WaveformIcon />}><select value={editingOptions.noiseCleanupMode} disabled={controlsDisabled} onChange={(event) => applyOption({ noiseCleanupMode: event.target.value })} aria-label="Noise Cleanup"><option>Off</option><option>Light</option><option>Balanced</option><option>Strong</option></select></Tool>
            <Tool title="Sample Rate" icon={<SpeakerSimpleHigh />}><select value={editingOptions.sampleRate} disabled={controlsDisabled} onChange={(event) => applyOption({ sampleRate: Number(event.target.value) })} aria-label="Sample rate"><option value={44100}>44.1 kHz</option><option value={48000}>48 kHz</option><option value={96000}>96 kHz</option></select></Tool>
            <Tool title="Output Depth" icon={<GearSix />}><select value={editingOptions.outputDepth} disabled={controlsDisabled} onChange={(event) => applyOption({ outputDepth: Number(event.target.value) })} aria-label="Output depth"><option value={16}>16-bit PCM</option><option value={24}>24-bit PCM</option><option value={32}>32-bit Float</option></select></Tool>
          </div>
          {selected.error && <div className="selected-error"><X weight="bold" /><span>{selected.error}</span></div>}
          <div className="waveform-area"><div className="timeline">{timelineLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div><Waveform playing={playing} position={position} peaks={previewWaveform} channels={previewChannels} onSeek={(ratio) => { const audio = audioRef.current; if (audio?.duration) audio.currentTime = ratio * audio.duration }} /><div className="db-scale"><span>0</span><span>-6</span><span>-12</span><span>-18</span><span>-24</span><span>-∞</span></div></div>
          <div className="transport-row"><time>{clockLabel(currentSeconds, true)}</time><div className="transport-wrap"><div className="transport-controls"><button type="button" aria-label="Previous"><SkipBack weight="fill" /></button><button type="button" aria-label="Rewind" onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10) }}><SkipBack /></button><button className="play-button" type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlayback}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button><button type="button" aria-label="Stop" onClick={() => { const audio = audioRef.current; if (audio) { audio.pause(); audio.currentTime = 0 } }}><Stop weight="fill" /></button><button type="button" aria-label="Fast forward" onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + 10) }}><SkipForward /></button></div><span className="space-hint">SPACE</span></div><div className="ab-control">{['A', 'B'].map((mode) => <button className={abMode === mode ? 'active' : ''} type="button" key={mode} disabled={mode === 'B' && !selected.outputPath} onClick={() => changeAbMode(mode)}>{mode}</button>)}<span>SYNC <b>ON</b></span></div></div>
          <div className="facts-row"><div><span>FORMAT</span><strong title={activeMetadata.codec}>{activeMetadata.container}</strong></div><div><span>SAMPLE RATE</span><strong>{compactSampleRate(activeMetadata.sampleRateHz)}</strong></div><div><span>BIT DEPTH</span><strong>{activeMetadata.bitDepth ? `${activeMetadata.bitDepth}-bit` : '—'}</strong></div><div><span>CHANNELS</span><strong>{activeMetadata.channelLayout}</strong></div><div><span>TRUE PEAK</span><strong className={activeMetadata.truePeak ? 'peak' : ''}>{activeMetadata.truePeak ?? 'Pending'}</strong></div><div><span>INTEGRATED LUFS</span><strong className={activeMetadata.lufs ? 'lufs' : ''}>{activeMetadata.lufs ?? 'Pending'}</strong></div></div>
          <div className="analysis-row"><div className="analysis-title"><i /> MEASURED ANALYSIS</div><div><span>NOISE FLOOR</span><strong>—</strong></div><div><span>DYNAMIC RANGE</span><strong>—</strong></div><div><span>PEAK LEVEL</span><strong>{activeMetadata.truePeak ?? '—'}</strong></div><div><span>LOUDNESS RANGE</span><strong>—</strong></div><div><span>CREST FACTOR</span><strong>—</strong></div><div><span>CLIPPING</span><strong>—</strong></div></div>
        </section>
        <footer className="actionbar"><div className="project-info"><button className="settings-button" type="button" aria-label="Open settings" title="Settings" disabled={processing} onClick={() => setSettingsOpen(true)}><GearSix size={25} /></button><span>ENGINE <strong>{engineStatus.label}</strong></span><span>{tracks.length} TRACKS</span>{importing && <span className="busy-label">IMPORTING</span>}</div>{selected.outputFolder && <button className="folder-button" type="button" onClick={openOutputFolder}><FolderOpen weight="bold" />OUTPUT FOLDER</button>}<button className="process-button secondary" type="button" onClick={() => processTracks(selected?.path ? [selected] : [])} disabled={processing || importing || !tracks.length}><DownloadSimple weight="bold" />PROCESS SELECTED</button><button className={`process-button ${processing ? 'processing' : ''}`} type="button" onClick={() => processTracks(tracks)} disabled={processing || importing || !tracks.length}><DownloadSimple weight="bold" />{processing ? 'PROCESSING…' : 'PROCESS ALL'}</button></footer>
        <SettingsModal open={settingsOpen} settings={appSettings} engineStatus={engineStatus} desktopRuntime={isTauriRuntime()} onClose={() => setSettingsOpen(false)} onSave={commitAppSettings} onBrowseOutputFolder={browseForOutputFolder} />
        {processSession && <ProcessingModal session={processSession} onOpenFolder={openOutputFolder} onClose={() => { if (!processing) setProcessSession(null) }} />}
        {notice && <div className="notice" role="status">{notice}</div>}
      </div>
    </main>
  )
}
