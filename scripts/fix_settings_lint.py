from pathlib import Path

path = Path('src/App.jsx')
text = path.read_text(encoding='utf-8')

old = '<button className="settings-button" type="button" aria-label="Open settings" title="Settings" disabled={processing} onClick={() => setSettingsOpen(true)}><GearSix size={25} /></button>'
new = '<button className="settings-button" type="button" aria-label="Open settings" title="Settings" disabled={processing || importing} onClick={() => setSettingsOpen(true)}><GearSix size={25} /></button>'
if text.count(old) != 1:
    raise RuntimeError(f'settings button replacement expected 1 match, found {text.count(old)}')
text = text.replace(old, new, 1)

old = '<SettingsModal open={settingsOpen} settings={appSettings} engineStatus={engineStatus} desktopRuntime={isTauriRuntime()} onClose={() => setSettingsOpen(false)} onSave={commitAppSettings} onBrowseOutputFolder={browseForOutputFolder} />'
new = '{settingsOpen && <SettingsModal settings={appSettings} engineStatus={engineStatus} desktopRuntime={isTauriRuntime()} onClose={() => setSettingsOpen(false)} onSave={commitAppSettings} onBrowseOutputFolder={browseForOutputFolder} />}'
if text.count(old) != 1:
    raise RuntimeError(f'settings modal replacement expected 1 match, found {text.count(old)}')
text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
print('Settings lint patch applied')
