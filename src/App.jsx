import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowsLeftRight, Check, DownloadSimple, GearSix, List, Pause, Play,
  SkipBack, SkipForward, SpeakerSimpleHigh, Stop,
  Waveform as WaveformIcon, Wrench,
} from '@phosphor-icons/react'

const seedTracks = [
  { id: 1, name: 'Song01_Vocal.wav', duration: '03:42', state: 'ready', progress: 100 },
  { id: 2, name: 'Song01_Drums.wav', duration: '03:42', state: 'done', progress: 100 },
  { id: 3, name: 'Song01_Bass.wav', duration: '03:42', state: 'done', progress: 100 },
  { id: 4, name: 'Song01_Guitars.wav', duration: '03:42', state: 'done', progress: 100 },
  { id: 5, name: 'Song01_Keys.wav', duration: '03:42', state: 'working', progress: 68 },
  { id: 6, name: 'Song01_Other.wav', duration: '03:42', state: 'queued', progress: 12 },
]

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
        <span className="track-meta">WAV&nbsp;&nbsp; 48 kHz&nbsp;&nbsp; 24-bit&nbsp;&nbsp; •&nbsp;&nbsp; {track.duration}</span>
        <span className="track-progress"><i style={{ width: `${track.progress}%` }} /></span>
      </span>
      <span className={`track-state ${track.state}`}>{statusIcon || `${track.progress}%`}</span>
    </button>
  )
}

export function App() {
  const [tracks, setTracks] = useState(seedTracks)
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

  const addFiles = (fileList) => {
    const audioFiles = [...fileList].filter((file) => file.type.startsWith('audio/') || /\.(wav|flac|mp3|aiff?)$/i.test(file.name))
    if (!audioFiles.length) { setNotice('No supported audio files found'); return }
    const now = Date.now()
    const added = audioFiles.map((file, index) => ({ id: now + index, name: file.name, duration: '--:--', state: 'queued', progress: 0 }))
    setTracks((current) => [...current, ...added])
    setSelectedId(added[0].id)
    setNotice(`${added.length} track${added.length > 1 ? 's' : ''} added`)
  }

  const processSelected = () => {
    if (processing) return
    setProcessing(true)
    setTracks((current) => current.map((track) => track.id === selectedId ? { ...track, state: 'working', progress: 32 } : track))
    window.setTimeout(() => {
      setTracks((current) => current.map((track) => track.id === selectedId ? { ...track, state: 'done', progress: 100 } : track))
      setProcessing(false)
      setNotice('Processing recipe completed')
    }, 1400)
  }

  return (
    <main className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files) }}>
      <input ref={fileInput} className="visually-hidden" type="file" multiple accept="audio/*,.wav,.flac,.aif,.aiff" onChange={(event) => addFiles(event.target.files)} />
      <header className="brandbar"><strong>NAS <em>VocRep</em></strong></header>

      <aside className="queue-panel">
        <div className="queue-heading"><span>TRACK QUEUE</span><span>{tracks.length} / {tracks.length}</span><button type="button" aria-label="Queue menu" onClick={() => fileInput.current?.click()}><List size={24} /></button></div>
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
          <div><span>FORMAT</span><strong>WAV</strong></div><div><span>SAMPLE RATE</span><strong>{sampleRate}</strong></div><div><span>BIT DEPTH</span><strong>24-bit</strong></div><div><span>CHANNELS</span><strong>{mono ? 'Mono' : 'Stereo'}</strong></div><div><span>TRUE PEAK</span><strong className="peak">-2.3 dBTP</strong></div><div><span>INTEGRATED LUFS</span><strong className="lufs">-17.8 LUFS</strong></div>
        </div>

        <div className="analysis-row">
          <div className="analysis-title"><i /> ESTIMATED ANALYSIS</div><div><span>NOISE FLOOR (RMS)</span><strong>-72.1 dB</strong></div><div><span>DYNAMIC RANGE</span><strong>13.6 dB</strong></div><div><span>PEAK LEVEL</span><strong>-2.3 dBTP</strong></div><div><span>LOUDNESS RANGE</span><strong>7.2 LU</strong></div><div><span>CREST FACTOR</span><strong>11.5 dB</strong></div><div><span>CLIPPING</span><strong>0 samples</strong></div>
        </div>
      </section>

      <footer className="actionbar">
        <div className="project-info"><GearSix size={28} /><span>Project: <strong>Song01</strong></span><span>Date: 2026-07-11</span></div>
        <button className={`process-button ${processing ? 'processing' : ''}`} type="button" onClick={processSelected}><WaveformIcon weight="bold" />{processing ? 'PROCESSING…' : 'PROCESS SELECTED'}</button>
        <button className="export-button" type="button" onClick={() => setNotice(`${selected.name} ready for Cubase`)}><DownloadSimple /> EXPORT FOR CUBASE</button>
      </footer>
      {notice && <div className="notice" role="status">{notice}</div>}
    </main>
  )
}
