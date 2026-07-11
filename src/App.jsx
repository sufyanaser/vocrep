import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowsLeftRight, Check, DownloadSimple, GearSix, List, Pause, Play,
  SkipBack, SkipForward, SpeakerSimpleHigh, Stop,
  Waveform as WaveformIcon, Wrench,
} from '@phosphor-icons/react'
import {
  analyzeBrowserFiles,
  checkNativeAudioEngine,
  analyzeNativePaths,
  browseNativeAudioFiles,
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

function trackFromMetadata(metadata, index, now) {
  const rawLayout = metadata.channelLayout || `${metadata.channels || 0} channels`
  return {
    id: `${now}-${index}-${metadata.path ?? metadata.name}`,
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
      const channelGap = visibleChannels > 1 ? 30 : 0
      const channelHeight = (rect.height - channelGap * (visibleChannels - 1)) / visibleChannels
      const centers = Array.from({ length: visibleChannels }, (_, channel) => channel * (channelHeight + channelGap) + channelHeight / 2)
      const bars = peaks?.[0]?.length || 0
      const step = rect.width / bars
      const waveformGradient = context.createLinearGradient(0, 0, rect.width, 0)
      waveformGradient.addColorStop(0, '#ff9818')
      waveformGradient.addColorStop(0.55, '#ffb02c')
      waveformGradient.addColorStop(1, '#ff9320')
      context.strokeStyle = waveformGradient
      context.lineWidth = Math.max(1, step * 0.56)

      if (bars) centers.forEach((center, channel) => {
        for (let index = 0; index < bars; index += 1) {
          const amplitude = Math.min(1, peaks[channel]?.[index] || 0) * (channelHeight * 0.43)
          const x = index * step + step / 2
          context.beginPath()
          context.moveTo(x, center - amplitude)
          context.lineTo(x, center + amplitude)
          context.stroke()
        }
      })

      const playheadX = rect.width * position
      context.strokeStyle = playing ? '#ffab22' : '#ff8a00'
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
  return (
    <button className={`toggle ${checked ? 'is-on' : ''}`} type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

function Tool({ icon, title, children, wide = false }) {
  return (
    <section className={`tool ${wide ? 'tool-wide' : ''}`}>
      <div className="tool-heading">{icon}<span>{title}</span></div>
      {children}
    </section>
  )
}

function TrackRow({ track, index, selected, onSelect }) {
  const statusIcon = track.state === 'done' ? <Check weight="bold" /> : track.state === 'working' ? 'RUN' : track.state === 'error' ? 'ERR' : null
  return (
    <button className={`track-row ${selected ? 'selected' : ''}`} type="button" onClick={onSelect}>
      <span className="track-number">{index + 1}</span>
      <Play className="track-play" weight="fill" />
      <span className="track-main">
        <span className="track-name">{track.name}</span>
        <span className="track-meta">{track.container}&nbsp;&nbsp; {compactSampleRate(track.sampleRateHz)}&nbsp;&nbsp; {track.bitDepth ? `${track.bitDepth}-bit` : '—'}&nbsp;&nbsp; •&nbsp;&nbsp; {track.duration}</span>
        <span className="track-progress"><i style={{ width: `${track.progress}%` }} /></span>
      </span>
      <span className={`track-state ${track.state}`}>{statusIcon || `${track.progress}%`}</span>
    </button>
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
  const [position, setPosition] = useState(0.012)
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
  const currentSeconds = position * (activeMetadata.durationSeconds || selected.durationSeconds || 0)
  const timelineLabels = Array.from({ length: 8 }, (_, index) => clockLabel((activeMetadata.durationSeconds || selected.durationSeconds || 0) * index / 7))

  useEffect(() => {
    const path = abMode === 'B' && selected.outputPath ? selected.outputPath : selected.path
    if (!path || previewWaveform || !isTauriRuntime()) return
    let active = true
    getNativeWaveform(path).then((data) => {
      if (!active || !data?.peaks) return
      setTracks((current) => current.map((track) => track.id === selected.id
        ? (abMode === 'B' ? { ...track, outputWaveform: data.peaks, outputChannels: data.channels } : { ...track, waveform: data.peaks, channels: data.channels })
        : track))
    }).catch((error) => setNotice(error.message || 'Unable to extract waveform'))
    return () => { active = false }
  }, [selected.id, selected.path, selected.outputPath, previewWaveform, abMode])

  useEffect(() => {
    if (!isTauriRuntime()) {
      setEngineStatus({ ready: false, label: 'PREVIEW' })
      return
    }
    checkNativeAudioEngine()
      .then((status) => {
        setEngineStatus({ ready: status.ready, label: status.ready ? 'READY' : 'MISSING' })
        if (!status.ready) setNotice(status.error || 'FFmpeg engine is incomplete')
      })
      .catch((error) => {
        setEngineStatus({ ready: false, label: 'ERROR' })
        setNotice(error.message || 'Audio engine check failed')
      })
  }, [])

  useEffect(() => {
    let active = true
    const previewPath = abMode === 'B' && selected.outputPath ? selected.outputPath : selected.path
    if (!previewPath || !isTauriRuntime()) {
      setPreviewUrl('')
      setPlaying(false)
      setPosition(0)
      return () => { active = false }
    }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      if (active) {
        setPreviewUrl(convertFileSrc(previewPath))
        setPlaying(false)
        setPosition(0)
      }
    }).catch((error) => setNotice(error.message || 'Unable to load audio preview'))
    return () => { active = false }
  }, [selected.path, selected.outputPath, abMode])

  const togglePlayback = async () => {
    const audio = audioRef.current
    if (!audio || !previewUrl) {
      setNotice('Select an imported track first')
      return
    }
    if (audio.paused) {
      try { await audio.play() } catch (error) { setNotice(error.message || 'Playback failed') }
    } else {
      audio.pause()
    }
  }

  const seekPreview = (delta) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta))
  }

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    document.querySelector('.track-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, tracks.length])

  const appendMetadata = useCallback(({ metadata, errors }) => {
    if (!metadata.length) {
      setNotice(errors[0] || 'No supported audio files found')
      return
    }
    const now = Date.now()
    const added = metadata.map((item, index) => trackFromMetadata(item, index, now))
    setTracks((current) => [...current, ...added])
    setSelectedId(added[0].id)
    setNotice(errors.length ? `${added.length} added · ${errors.length} failed` : `${added.length} track${added.length > 1 ? 's' : ''} analyzed`)
  }, [])

  const addFiles = useCallback(async (fileList) => {
    if (!fileList?.length || importing) return
    setImporting(true)
    setNotice(`Analyzing ${fileList.length} track${fileList.length > 1 ? 's' : ''}…`)
    try {
      appendMetadata(await analyzeBrowserFiles(fileList))
    } catch (error) {
      setNotice(error.message || 'Audio analysis failed')
    } finally {
      setImporting(false)
    }
  }, [appendMetadata, importing])

  const addNativePaths = useCallback(async (paths) => {
    if (!paths?.length || importing) return
    setImporting(true)
    setNotice(`Analyzing ${paths.length} track${paths.length > 1 ? 's' : ''}…`)
    try {
      appendMetadata(await analyzeNativePaths(paths))
    } catch (error) {
      setNotice(error.message || 'FFprobe analysis failed')
    } finally {
      setImporting(false)
    }
  }, [appendMetadata, importing])

  const browseForTracks = useCallback(async () => {
    if (!isTauriRuntime()) {
      fileInput.current?.click()
      return
    }
    try {
      const paths = await browseNativeAudioFiles()
      await addNativePaths(paths)
    } catch (error) {
      setNotice(error.message || 'Unable to open audio files')
    }
  }, [addNativePaths])

  useEffect(() => {
    let unlisten = () => {}
    let mounted = true
    listenForNativeDrop(addNativePaths).then((cleanup) => {
      if (mounted) unlisten = cleanup
      else cleanup()
    }).catch((error) => setNotice(error.message || 'Native drop listener failed'))
    return () => {
      mounted = false
      unlisten()
    }
  }, [addNativePaths])

  const processTracks = async (targets) => {
    if (processing) return
    if (!engineStatus.ready) {
      setNotice('FFmpeg engine is not ready')
      return
    }
    const nativeTargets = targets.filter((track) => track.path)
    if (!nativeTargets.length) {
      setNotice('Import local tracks to process them')
      return
    }
    const options = {
      mono,
      normalize,
      repair,
      repairMode,
      sampleRate: sampleRate === '44.1 kHz' ? 44100 : 48000,
    }
    setProcessing(true)
    let completedCount = 0
    let failedCount = 0
    for (const target of nativeTargets) {
      setSelectedId(target.id)
      setTracks((current) => current.map((track) => track.id === target.id ? { ...track, state: 'working', progress: 0, error: null } : track))
      try {
        const result = await processNativeAudio([target.path], options)
        if (!result.completed.length) throw new Error(result.errors[0] || 'Processing failed')
        const outputPath = result.completed[0].outputPath
        const [outputMetadataResult, outputWaveform] = await Promise.all([
          analyzeNativePaths([outputPath]),
          getNativeWaveform(outputPath),
        ])
        const outputMetadata = outputMetadataResult.metadata[0]
        completedCount += 1
        setTracks((current) => current.map((track) => track.id === target.id ? {
          ...track, state: 'done', progress: 100, outputPath,
          outputWaveform: outputWaveform?.peaks || null,
          outputChannels: outputMetadata?.channels || outputWaveform?.channels || (mono ? 1 : track.channels),
          outputMetadata,
        } : track))
        setAbMode('B')
      } catch (error) {
        failedCount += 1
        setTracks((current) => current.map((track) => track.id === target.id ? { ...track, state: 'error', progress: 0, error: error.message || 'Processing failed' } : track))
      }
    }
    setProcessing(false)
    setNotice(failedCount ? `${completedCount} exported · ${failedCount} failed` : `${completedCount} track${completedCount > 1 ? 's' : ''} saved to CUBASE_READY`)
  }

  const processSelected = () => processTracks(selected ? [selected] : [])
  const exportAll = () => processTracks(tracks)

  return (
    <main className={`app-shell ${importing ? 'is-importing' : ''}`}>
      <audio
        ref={audioRef}
        src={previewUrl}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget
          setPosition(audio.duration ? audio.currentTime / audio.duration : 0)
        }}
      />
      <div className="drop-surface" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files) }}>
      <input ref={fileInput} className="visually-hidden" type="file" multiple accept="audio/*,.wav,.wave,.flac,.mp3,.m4a,.aac,.ogg,.opus,.aif,.aiff" onChange={(event) => { addFiles(event.target.files); event.target.value = '' }} />
      <header className="brandbar"><strong>NAS <em>VocRep</em></strong></header>

      <aside className="queue-panel">
        <div className="queue-heading"><span>TRACK QUEUE</span><span>{tracks.length} / {tracks.length}</span><button type="button" aria-label="Import tracks" onClick={browseForTracks} disabled={importing}><List size={24} /></button></div>
        <div className="track-list">{tracks.map((track, index) => <TrackRow key={track.id} track={track} index={index} selected={track.id === selectedId} onSelect={() => setSelectedId(track.id)} />)}</div>
      </aside>

      <section className="workspace">
        <div className="tools-row">
          <Tool title="Stereo to Mono" icon={<ArrowsLeftRight />}><Toggle checked={mono} onChange={setMono} label="Stereo to Mono" /></Tool>
          <Tool title="Normalize" icon={<WaveformIcon />}><Toggle checked={normalize} onChange={setNormalize} label="Normalize" /></Tool>
          <Tool title="Stem Repair" icon={<Wrench />} wide>
            <div className="repair-controls"><Toggle checked={repair} onChange={setRepair} label="Stem Repair" /><div className={`segments ${repair ? '' : 'is-disabled'}`}>{['Light', 'Balanced', 'Strong'].map((mode) => <button className={repairMode === mode ? 'active' : ''} key={mode} type="button" onClick={() => setRepairMode(mode)}>{mode}</button>)}</div></div>
          </Tool>
          <Tool title="Sample Rate" icon={<SpeakerSimpleHigh />}><select value={sampleRate} onChange={(event) => setSampleRate(event.target.value)} aria-label="Sample rate"><option>44.1 kHz</option><option>48 kHz</option></select></Tool>
        </div>

        <div className="waveform-area">
          <div className="timeline">{timelineLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>
          <Waveform playing={playing} position={position} peaks={previewWaveform} channels={previewChannels} onSeek={(ratio) => { const audio = audioRef.current; if (audio?.duration) audio.currentTime = ratio * audio.duration }} />
          <div className="db-scale"><span>0</span><span>-6</span><span>-12</span><span>-18</span><span>-24</span><span>-∞</span></div>
        </div>

        <div className="transport-row">
          <time>{clockLabel(currentSeconds, true)}</time>
          <div className="transport-controls">
            <button type="button" aria-label="Previous"><SkipBack weight="fill" /></button><button type="button" aria-label="Rewind" onClick={() => seekPreview(-10)}><SkipBack /></button>
            <button className="play-button" type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlayback}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button>
            <button type="button" aria-label="Stop" onClick={() => { const audio = audioRef.current; if (audio) { audio.pause(); audio.currentTime = 0 } }}><Stop weight="fill" /></button><button type="button" aria-label="Fast forward" onClick={() => seekPreview(10)}><SkipForward /></button>
          </div>
          <div className="ab-control">{['A', 'B'].map((mode) => <button className={abMode === mode ? 'active' : ''} type="button" key={mode} onClick={() => setAbMode(mode)}>{mode}</button>)}<span>SYNC <b>ON</b></span></div>
        </div>

        <div className="facts-row">
          <div><span>FORMAT</span><strong title={activeMetadata.codec}>{activeMetadata.container}</strong></div><div><span>SAMPLE RATE</span><strong>{compactSampleRate(activeMetadata.sampleRateHz)}</strong></div><div><span>BIT DEPTH</span><strong>{activeMetadata.bitDepth ? `${activeMetadata.bitDepth}-bit` : '—'}</strong></div><div><span>CHANNELS</span><strong>{activeMetadata.channelLayout}</strong></div><div><span>TRUE PEAK</span><strong className={activeMetadata.truePeak ? 'peak' : ''}>{activeMetadata.truePeak ?? 'Pending'}</strong></div><div><span>INTEGRATED LUFS</span><strong className={activeMetadata.lufs ? 'lufs' : ''}>{activeMetadata.lufs ?? 'Pending'}</strong></div>
        </div>

        <div className="analysis-row">
          <div className="analysis-title"><i /> MEASURED ANALYSIS</div><div><span>NOISE FLOOR (RMS)</span><strong>—</strong></div><div><span>DYNAMIC RANGE</span><strong>—</strong></div><div><span>PEAK LEVEL</span><strong>{activeMetadata.truePeak ?? '—'}</strong></div><div><span>LOUDNESS RANGE</span><strong>—</strong></div><div><span>CREST FACTOR</span><strong>—</strong></div><div><span>CLIPPING</span><strong>—</strong></div>
        </div>
      </section>

      <footer className="actionbar">
        <div className="project-info"><GearSix size={28} /><span>ENGINE: <strong>{engineStatus.label}</strong></span><span>{tracks.filter((track) => track.path).length} LOCAL TRACKS</span></div>
        <button className={`process-button ${processing ? 'processing' : ''}`} type="button" onClick={processSelected} disabled={processing || !tracks.length}><DownloadSimple weight="bold" />{processing ? 'PROCESSING…' : 'RUN PROCESS'}</button>
        <button className="export-button" type="button" onClick={exportAll} disabled={processing}><DownloadSimple /> {processing ? 'EXPORTING…' : 'EXPORT ALL FOR CUBASE'}</button>
      </footer>
      {notice && <div className="notice" role="status">{notice}</div>}
      </div>
    </main>
  )
}
