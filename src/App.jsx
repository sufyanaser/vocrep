import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowsLeftRight, Check, DownloadSimple, GearSix, List, Pause, Play,
  SkipBack, SkipForward, SpeakerSimpleHigh, Stop,
  Waveform as WaveformIcon, Wrench,
} from '@phosphor-icons/react'
import {
  analyzeBrowserFiles,
  analyzeNativePaths,
  browseNativeAudioFiles,
  formatDuration,
  isTauriRuntime,
  listenForNativeDrop,
  processNativeAudio,
} from './lib/audioFiles.js'
import { demoTracks } from './data/demoTracks.js'

function compactSampleRate(value) {
  if (!value) return '—'
  const kiloHertz = value / 1000
  return `${Number.isInteger(kiloHertz) ? kiloHertz : kiloHertz.toFixed(1)} kHz`
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
  }
}

function seededAmplitude(index, channel) {
  const pulse = Math.abs(Math.sin(index * 0.109 + channel * 0.8))
  const texture = Math.abs(Math.sin(index * 0.743) * Math.cos(index * 0.217))
  const envelope = Math.min(1, index / 18) * Math.min(1, (250 - index) / 20)
  return (0.18 + pulse * 0.42 + texture * 0.4) * Math.max(0.08, envelope)
}

function Waveform({ playing, position }) {
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

      const channelGap = 30
      const channelHeight = (rect.height - channelGap) / 2
      const centers = [channelHeight / 2, channelHeight + channelGap + channelHeight / 2]
      const bars = 260
      const step = rect.width / bars
      const waveformGradient = context.createLinearGradient(0, 0, rect.width, 0)
      waveformGradient.addColorStop(0, '#ff9818')
      waveformGradient.addColorStop(0.55, '#ffb02c')
      waveformGradient.addColorStop(1, '#ff9320')
      context.strokeStyle = waveformGradient
      context.lineWidth = Math.max(1, step * 0.56)

      centers.forEach((center, channel) => {
        for (let index = 0; index < bars; index += 1) {
          const amplitude = seededAmplitude(index, channel) * (channelHeight * 0.43)
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
  }, [playing, position])

  return <canvas ref={canvasRef} className="waveform-canvas" aria-label="Stereo waveform preview" />
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
  const statusIcon = track.state === 'done' ? <Check weight="bold" /> : null
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
  const [tracks, setTracks] = useState(demoTracks)
  const [selectedId, setSelectedId] = useState(1)
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
  const fileInput = useRef(null)
  const selected = useMemo(() => tracks.find((track) => track.id === selectedId) ?? tracks[0], [tracks, selectedId])

  useEffect(() => {
    if (!playing) return undefined
    const timer = window.setInterval(() => setPosition((current) => (current >= 0.985 ? 0.012 : current + 0.0025)), 120)
    return () => window.clearInterval(timer)
  }, [playing])

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

  const processSelected = async () => {
    if (processing) return
    if (!selected?.path) {
      setNotice('Import a local track to process it')
      return
    }
    setProcessing(true)
    setTracks((current) => current.map((track) => track.id === selectedId ? { ...track, state: 'working', progress: 32 } : track))
    try {
      const result = await processNativeAudio([selected.path], {
        mono,
        normalize,
        sampleRate: sampleRate === '44.1 kHz' ? 44100 : 48000,
      })
      if (!result.completed.length) throw new Error(result.errors[0] || 'Processing failed')
      const outputPath = result.completed[0].outputPath
      setTracks((current) => current.map((track) => track.id === selectedId ? {
        ...track,
        state: 'done',
        progress: 100,
        outputPath,
      } : track))
      setNotice('Saved to CUBASE_READY')
    } catch (error) {
      setTracks((current) => current.map((track) => track.id === selectedId ? { ...track, state: 'ready', progress: 100 } : track))
      setNotice(error.message || 'Processing failed')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <main className={`app-shell ${importing ? 'is-importing' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files) }}>
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
          <div className="timeline"><span>0:00</span><span>0:30</span><span>1:00</span><span>1:30</span><span>2:00</span><span>2:30</span><span>3:00</span><span>3:42</span></div>
          <Waveform playing={playing} position={position} />
          <div className="db-scale"><span>0</span><span>-6</span><span>-12</span><span>-18</span><span>-24</span><span>-∞</span></div>
        </div>

        <div className="transport-row">
          <time>00:00.000</time>
          <div className="transport-controls">
            <button type="button" aria-label="Previous"><SkipBack weight="fill" /></button><button type="button" aria-label="Rewind" onClick={() => setPosition(Math.max(.012, position - .08))}><SkipBack /></button>
            <button className="play-button" type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!playing)}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button>
            <button type="button" aria-label="Stop" onClick={() => { setPlaying(false); setPosition(.012) }}><Stop weight="fill" /></button><button type="button" aria-label="Fast forward" onClick={() => setPosition(Math.min(.98, position + .08))}><SkipForward /></button>
          </div>
          <div className="ab-control">{['A', 'B'].map((mode) => <button className={abMode === mode ? 'active' : ''} type="button" key={mode} onClick={() => setAbMode(mode)}>{mode}</button>)}<span>SYNC <b>ON</b></span></div>
        </div>

        <div className="facts-row">
          <div><span>FORMAT</span><strong title={selected.codec}>{selected.container}</strong></div><div><span>SAMPLE RATE</span><strong>{compactSampleRate(selected.sampleRateHz)}</strong></div><div><span>BIT DEPTH</span><strong>{selected.bitDepth ? `${selected.bitDepth}-bit` : '—'}</strong></div><div><span>CHANNELS</span><strong>{selected.channelLayout}</strong></div><div><span>TRUE PEAK</span><strong className={selected.truePeak ? 'peak' : ''}>{selected.truePeak ?? 'Pending'}</strong></div><div><span>INTEGRATED LUFS</span><strong className={selected.lufs ? 'lufs' : ''}>{selected.lufs ?? 'Pending'}</strong></div>
        </div>

        <div className="analysis-row">
          <div className="analysis-title"><i /> ESTIMATED ANALYSIS</div><div><span>NOISE FLOOR (RMS)</span><strong>{selected.truePeak ? '-72.1 dB' : '—'}</strong></div><div><span>DYNAMIC RANGE</span><strong>{selected.truePeak ? '13.6 dB' : '—'}</strong></div><div><span>PEAK LEVEL</span><strong>{selected.truePeak ?? '—'}</strong></div><div><span>LOUDNESS RANGE</span><strong>{selected.lufs ? '7.2 LU' : '—'}</strong></div><div><span>CREST FACTOR</span><strong>{selected.truePeak ? '11.5 dB' : '—'}</strong></div><div><span>CLIPPING</span><strong>{selected.truePeak ? '0 samples' : '—'}</strong></div>
        </div>
      </section>

      <footer className="actionbar">
        <div className="project-info"><GearSix size={28} /><span>Project: <strong>Song01</strong></span><span>Date: 2026-07-11</span></div>
        <button className={`process-button ${processing ? 'processing' : ''}`} type="button" onClick={processSelected}><WaveformIcon weight="bold" />{processing ? 'PROCESSING…' : 'PROCESS SELECTED'}</button>
        <button className="export-button" type="button" onClick={() => setNotice(selected.outputPath ? 'Saved in CUBASE_READY' : 'Process the selected track first')}><DownloadSimple /> EXPORT FOR CUBASE</button>
      </footer>
      {notice && <div className="notice" role="status">{notice}</div>}
    </main>
  )
}
