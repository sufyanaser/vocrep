import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowsLeftRight, Check, DownloadSimple, GearSix, Pause, Play, Plus,
  SkipBack, SkipForward, SpeakerSimpleHigh, Stop, Trash, X,
  Waveform as WaveformIcon, Wrench,
} from '@phosphor-icons/react'
import {
  analyzeBrowserFiles,
  analyzeNativePaths,
  browseNativeAudioFiles,
  checkNativeAudioEngine,
  formatDuration,
  getNativeWaveform,
  isTauriRuntime,
  listenForNativeDrop,
  processNativeAudio,
} from './lib/audioFiles.js'

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

function trackFromMetadata(metadata, index = 0) {
  const rawLayout = metadata.channelLayout || `${metadata.channels || 0} channels`
  return {
    id: `${Date.now()}-${index}-${metadata.path ?? metadata.name}`,
    name: metadata.name,
    path: metadata.path,
    duration: formatDuration(metadata.durationSeconds),
    durationSeconds: metadata.durationSeconds,
    state: 'ready',
    progress: 100,
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

function Toggle({ checked, onChange, label }) {
  return <button className={`toggle ${checked ? 'is-on' : ''}`} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>
}

function Tool({ icon, title, children, wide = false }) {
  return <section className={`tool ${wide ? 'tool-wide' : ''}`}><div className="tool-heading">{icon}<span>{title}</span></div>{children}</section>
}

function TrackRow({ track, index, selected, disabled, onSelect, onRemove }) {
  const statusIcon = track.state === 'done' ? <Check weight="bold" /> : track.state === 'working' ? 'RUN' : track.state === 'error' ? 'ERR' : null
  return (
    <div className={`track-row ${selected ? 'selected' : ''}`} role="button" tabIndex={0} onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect() }}>
      <span className="track-number">{index + 1}</span>
      <Play className="track-play" weight="fill" />
      <span className="track-main">
        <span className="track-name">{track.name}</span>
        <span className="track-meta">{track.container} · {compactSampleRate(track.sampleRateHz)} · {track.bitDepth ? `${track.bitDepth}-bit` : '—'} · {track.duration}</span>
        <span className="track-progress"><i style={{ width: `${track.progress}%` }} /></span>
      </span>
      <span className={`track-state ${track.state}`}>{statusIcon || `${track.progress}%`}</span>
      <button className="track-remove" type="button" aria-label={`Remove ${track.name}`} disabled={disabled} onClick={(event) => { event.stopPropagation(); onRemove() }}><X weight="bold" /></button>
    </div>
  )
}

export function App() {
  const [tracks, setTracks] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [mono, setMono] = useState(false)
  const [normalize, setNormalize] = useState(false)
  const [repair, setRepair] = useState(true)
  const [repairMode, setRepairMode] = useState('Balanced')
  const [sampleRate, setSampleRate] = useState('48 kHz')
  const [playing, setPlaying] = useState(false)
  const [abMode, setAbMode] = useState('A')
  const [position, setPosition] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [engineStatus, setEngineStatus] = useState({ ready: false, label: 'CHECKING' })
  const fileInput = useRef(null)
  const audioRef = useRef(null)
  const emptyTrack = useMemo(() => ({ name: 'No track selected', codec: '', container: '—', sampleRateHz: 0, bitDepth: null, channelLayout: '—', truePeak: null, lufs: null }), [])
  const selected = useMemo(() => tracks.find((track) => track.id === selectedId) ?? tracks[0] ?? emptyTrack, [tracks, selectedId, emptyTrack])
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
        const track = trackFromMetadata(item, index)
        firstId ??= track.id
        addedCount += 1
        return [track]
      })
      return [...current, ...additions]
    })
    if (selectFirst && firstId) setSelectedId(firstId)
    return addedCount
  }, [])

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
    setNotice('QUEUE CLEARED')
  }, [processing])

  useEffect(() => {
    if (!isTauriRuntime()) return setEngineStatus({ ready: false, label: 'PREVIEW' })
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
    if (!previewPath || !isTauriRuntime()) { setPreviewUrl(''); setPlaying(false); setPosition(0); return () => { active = false } }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => { if (active) { setPreviewUrl(convertFileSrc(previewPath)); setPlaying(false); setPosition(0) } }).catch((error) => setNotice(error.message || 'Unable to load audio preview'))
    return () => { active = false }
  }, [selected.path, selected.outputPath, abMode])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  const togglePlayback = async () => {
    const audio = audioRef.current
    if (!audio || !previewUrl) return setNotice('SELECT AN IMPORTED TRACK')
    if (audio.paused) { try { await audio.play() } catch (error) { setNotice(error.message || 'Playback failed') } } else audio.pause()
  }

  const processTracks = async (targets) => {
    if (processing) return
    if (!engineStatus.ready) return setNotice('FFMPEG ENGINE IS NOT READY')
    const nativeTargets = targets.filter((track) => track.path)
    if (!nativeTargets.length) return setNotice('IMPORT LOCAL TRACKS FIRST')
    const options = { mono, normalize, repair, repairMode, sampleRate: sampleRate === '44.1 kHz' ? 44100 : 48000 }
    setProcessing(true)
    let completed = 0
    let failed = 0
    for (const target of nativeTargets) {
      setSelectedId(target.id)
      setTracks((current) => current.map((track) => track.id === target.id ? { ...track, state: 'working', progress: 0, error: null } : track))
      try {
        const result = await processNativeAudio([target.path], options)
        if (!result.completed.length) throw new Error(result.errors[0] || 'Processing failed')
        const outputPath = result.completed[0].outputPath
        const [metadataResult, waveform] = await Promise.all([analyzeNativePaths([outputPath]), getNativeWaveform(outputPath)])
        const outputMetadata = metadataResult.metadata[0]
        completed += 1
        setTracks((current) => current.map((track) => track.id === target.id ? { ...track, state: 'done', progress: 100, outputPath, outputWaveform: waveform?.peaks || null, outputChannels: outputMetadata?.channels || waveform?.channels || (mono ? 1 : track.channels), outputMetadata } : track))
      } catch (error) {
        failed += 1
        setTracks((current) => current.map((track) => track.id === target.id ? { ...track, state: 'error', progress: 0, error: error.message || 'Processing failed' } : track))
      }
    }
    setProcessing(false)
    if (completed) setAbMode('B')
    setNotice(`${completed} PROCESSED${failed ? ` · ${failed} FAILED` : ''}`)
  }

  return (
    <main className={`app-shell ${importing ? 'is-importing' : ''}`}>
      <audio ref={audioRef} src={previewUrl} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => { const audio = event.currentTarget; setPosition(audio.duration ? audio.currentTime / audio.duration : 0) }} />
      <div className="drop-surface" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files) }}>
        <input ref={fileInput} className="visually-hidden" type="file" multiple accept="audio/*,.wav,.wave,.flac,.mp3,.m4a,.aac,.ogg,.opus,.aif,.aiff" onChange={(event) => { addFiles(event.target.files); event.target.value = '' }} />
        <header className="brandbar"><strong>NAS <em>VocRep</em></strong><span>SUNO STEM PREPARATION</span></header>
        <aside className="queue-panel">
          <div className="queue-heading"><div><span>TRACK QUEUE</span><b>{tracks.length}</b></div><div className="queue-actions"><button type="button" onClick={browseForTracks} disabled={importing || processing}><Plus weight="bold" /> ADD TRACKS</button><button className="icon-action" type="button" aria-label="Clear queue" title="Clear queue" onClick={clearQueue} disabled={!tracks.length || processing}><Trash /></button></div></div>
          <div className="track-list">{tracks.length ? tracks.map((track, index) => <TrackRow key={track.id} track={track} index={index} selected={track.id === selectedId} disabled={processing} onSelect={() => setSelectedId(track.id)} onRemove={() => removeTrack(track.id)} />) : <div className="queue-empty"><Plus /><strong>ADD AUDIO TRACKS</strong><span>Drop multiple files or browse from disk</span><button type="button" onClick={browseForTracks}>BROWSE FILES</button></div>}</div>
        </aside>
        <section className="workspace">
          <div className="tools-row">
            <Tool title="Stereo to Mono" icon={<ArrowsLeftRight />}><Toggle checked={mono} onChange={setMono} label="Stereo to Mono" /></Tool>
            <Tool title="Normalize" icon={<WaveformIcon />}><Toggle checked={normalize} onChange={setNormalize} label="Normalize" /></Tool>
            <Tool title="Stem Repair" icon={<Wrench />} wide><div className="repair-controls"><Toggle checked={repair} onChange={setRepair} label="Stem Repair" /><div className={`segments ${repair ? '' : 'is-disabled'}`}>{['Light', 'Balanced', 'Strong'].map((mode) => <button className={repairMode === mode ? 'active' : ''} key={mode} type="button" onClick={() => setRepairMode(mode)}>{mode}</button>)}</div></div></Tool>
            <Tool title="Sample Rate" icon={<SpeakerSimpleHigh />}><select value={sampleRate} onChange={(event) => setSampleRate(event.target.value)} aria-label="Sample rate"><option>44.1 kHz</option><option>48 kHz</option></select></Tool>
          </div>
          <div className="waveform-area"><div className="timeline">{timelineLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div><Waveform playing={playing} position={position} peaks={previewWaveform} channels={previewChannels} onSeek={(ratio) => { const audio = audioRef.current; if (audio?.duration) audio.currentTime = ratio * audio.duration }} /><div className="db-scale"><span>0</span><span>-6</span><span>-12</span><span>-18</span><span>-24</span><span>-∞</span></div></div>
          <div className="transport-row"><time>{clockLabel(currentSeconds, true)}</time><div className="transport-controls"><button type="button" aria-label="Previous"><SkipBack weight="fill" /></button><button type="button" aria-label="Rewind" onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10) }}><SkipBack /></button><button className="play-button" type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlayback}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button><button type="button" aria-label="Stop" onClick={() => { const audio = audioRef.current; if (audio) { audio.pause(); audio.currentTime = 0 } }}><Stop weight="fill" /></button><button type="button" aria-label="Fast forward" onClick={() => { if (audioRef.current) audioRef.current.currentTime = Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + 10) }}><SkipForward /></button></div><div className="ab-control">{['A', 'B'].map((mode) => <button className={abMode === mode ? 'active' : ''} type="button" key={mode} onClick={() => setAbMode(mode)}>{mode}</button>)}<span>SYNC <b>ON</b></span></div></div>
          <div className="facts-row"><div><span>FORMAT</span><strong title={activeMetadata.codec}>{activeMetadata.container}</strong></div><div><span>SAMPLE RATE</span><strong>{compactSampleRate(activeMetadata.sampleRateHz)}</strong></div><div><span>BIT DEPTH</span><strong>{activeMetadata.bitDepth ? `${activeMetadata.bitDepth}-bit` : '—'}</strong></div><div><span>CHANNELS</span><strong>{activeMetadata.channelLayout}</strong></div><div><span>TRUE PEAK</span><strong className={activeMetadata.truePeak ? 'peak' : ''}>{activeMetadata.truePeak ?? 'Pending'}</strong></div><div><span>INTEGRATED LUFS</span><strong className={activeMetadata.lufs ? 'lufs' : ''}>{activeMetadata.lufs ?? 'Pending'}</strong></div></div>
          <div className="analysis-row"><div className="analysis-title"><i /> MEASURED ANALYSIS</div><div><span>NOISE FLOOR</span><strong>—</strong></div><div><span>DYNAMIC RANGE</span><strong>—</strong></div><div><span>PEAK LEVEL</span><strong>{activeMetadata.truePeak ?? '—'}</strong></div><div><span>LOUDNESS RANGE</span><strong>—</strong></div><div><span>CREST FACTOR</span><strong>—</strong></div><div><span>CLIPPING</span><strong>—</strong></div></div>
        </section>
        <footer className="actionbar"><div className="project-info"><GearSix size={25} /><span>ENGINE <strong>{engineStatus.label}</strong></span><span>{tracks.length} TRACKS</span>{importing && <span className="busy-label">IMPORTING</span>}</div><button className="process-button secondary" type="button" onClick={() => processTracks(selected?.path ? [selected] : [])} disabled={processing || importing || !tracks.length}><DownloadSimple weight="bold" />PROCESS SELECTED</button><button className={`process-button ${processing ? 'processing' : ''}`} type="button" onClick={() => processTracks(tracks)} disabled={processing || importing || !tracks.length}><DownloadSimple weight="bold" />{processing ? 'PROCESSING…' : 'PROCESS ALL'}</button></footer>
        {notice && <div className="notice" role="status">{notice}</div>}
      </div>
    </main>
  )
}
