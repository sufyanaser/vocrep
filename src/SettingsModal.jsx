import { useEffect, useState } from 'react'
import { FolderOpen, GearSix, X } from '@phosphor-icons/react'
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from './appSettings.js'

function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      className={`settings-switch ${checked ? 'is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function SettingsModal({ open, settings, engineStatus, desktopRuntime, onClose, onSave, onBrowseOutputFolder }) {
  const [draft, setDraft] = useState(() => normalizeAppSettings(settings))
  const [browseError, setBrowseError] = useState('')

  const closeWithoutSaving = () => {
    setDraft(normalizeAppSettings(settings))
    setBrowseError('')
    onClose()
  }

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setDraft(normalizeAppSettings(settings))
        setBrowseError('')
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, settings])

  if (!open) return null

  const update = (patch) => setDraft((current) => ({ ...current, ...patch }))
  const chooseOutputFolder = async () => {
    setBrowseError('')
    try {
      const folder = await onBrowseOutputFolder()
      if (folder) update({ outputDirectory: folder, outputMode: 'custom' })
    } catch (error) {
      setBrowseError(error?.message || 'Unable to choose output folder')
    }
  }

  const customOutputInvalid = draft.outputMode === 'custom' && !draft.outputDirectory.trim()

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeWithoutSaving() }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <div>
            <span>NAS VOCREP V04</span>
            <h2 id="settings-title"><GearSix weight="bold" /> SETTINGS</h2>
          </div>
          <button type="button" className="settings-close" aria-label="Close settings" onClick={closeWithoutSaving}><X weight="bold" /></button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-section-title"><strong>OUTPUT</strong><span>Where processed WAV files are written.</span></div>
            <label className="settings-field">
              <span>LOCATION</span>
              <select value={draft.outputMode} onChange={(event) => update({ outputMode: event.target.value })}>
                <option value="source">CUBASE_READY beside each source</option>
                <option value="custom">Custom output folder</option>
              </select>
            </label>
            {draft.outputMode === 'custom' && (
              <div className="settings-folder-row">
                <div className={`settings-path ${customOutputInvalid ? 'is-invalid' : ''}`} title={draft.outputDirectory || 'No folder selected'}>{draft.outputDirectory || 'No folder selected'}</div>
                <button type="button" onClick={chooseOutputFolder} disabled={!desktopRuntime}><FolderOpen weight="bold" />BROWSE</button>
              </div>
            )}
            <label className="settings-field">
              <span>FILE NAMING</span>
              <select value={draft.namingMode} onChange={(event) => update({ namingMode: event.target.value })}>
                <option value="detailed">Detailed processing suffix</option>
                <option value="compact">Compact Ready + channel + rate</option>
              </select>
            </label>
            {browseError && <div className="settings-error">{browseError}</div>}
          </section>

          <section className="settings-section">
            <div className="settings-section-title"><strong>PROCESSING DEFAULTS</strong><span>Applied to new imports after settings are saved.</span></div>
            <div className="settings-grid">
              <label className="settings-field">
                <span>SAMPLE RATE</span>
                <select value={draft.defaultSampleRate} onChange={(event) => update({ defaultSampleRate: Number(event.target.value) })}>
                  <option value={44100}>44.1 kHz</option>
                  <option value={48000}>48 kHz</option>
                  <option value={96000}>96 kHz</option>
                </select>
              </label>
              <label className="settings-field">
                <span>OUTPUT DEPTH</span>
                <select value={draft.defaultOutputDepth} onChange={(event) => update({ defaultOutputDepth: Number(event.target.value) })}>
                  <option value={16}>16-bit PCM</option>
                  <option value={24}>24-bit PCM</option>
                  <option value={32}>32-bit Float</option>
                </select>
              </label>
            </div>
          </section>

          <section className="settings-section settings-workflow">
            <div className="settings-section-title"><strong>WORKFLOW</strong><span>Small automation that does not change the audio.</span></div>
            <div className="settings-switch-row">
              <div><strong>OPEN OUTPUT FOLDER AFTER PROCESSING</strong><span>Open the final destination when a batch completes.</span></div>
              <Switch checked={draft.openOutputFolderAfterProcess} onChange={(value) => update({ openOutputFolderAfterProcess: value })} label="Open output folder after processing" />
            </div>
          </section>

          <section className="settings-section settings-status-grid">
            <div><span>ENGINE</span><strong className={engineStatus.ready ? 'is-ready' : ''}>{engineStatus.label}</strong></div>
            <div><span>UPDATES</span><strong>AUTOMATIC</strong><small>GitHub latest.json</small></div>
            <div><span>VERSION</span><strong>V04</strong><small>0.4.0</small></div>
          </section>
        </div>

        <footer className="settings-actions">
          <button type="button" className="settings-reset" onClick={() => setDraft({ ...DEFAULT_APP_SETTINGS })}>RESET DEFAULTS</button>
          <span />
          <button type="button" className="settings-cancel" onClick={closeWithoutSaving}>CANCEL</button>
          <button type="button" className="settings-save" disabled={customOutputInvalid} onClick={() => onSave(draft)}>SAVE SETTINGS</button>
        </footer>
      </section>
    </div>
  )
}
