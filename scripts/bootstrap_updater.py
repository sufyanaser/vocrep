from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLACEHOLDER = "__TAURI_UPDATER_PUBLIC_KEY__"
REPO = "sufyanaser/vocrep"


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def update_versions() -> None:
    package_path = ROOT / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    package["version"] = "0.4.0"
    write_json(package_path, package)

    lock_path = ROOT / "package-lock.json"
    if lock_path.exists():
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        lock["version"] = "0.4.0"
        if isinstance(lock.get("packages"), dict) and isinstance(lock["packages"].get(""), dict):
            lock["packages"][""]["version"] = "0.4.0"
        write_json(lock_path, lock)

    cargo_path = ROOT / "src-tauri" / "Cargo.toml"
    cargo = cargo_path.read_text(encoding="utf-8")
    cargo = re.sub(
        r'(?ms)(\[package\].*?^version\s*=\s*")([^"]+)(")',
        r'\g<1>0.4.0\3',
        cargo,
        count=1,
    )
    if "tauri-plugin-updater" not in cargo:
        cargo = cargo.replace(
            'tauri-plugin-dialog = "2"',
            'tauri-plugin-dialog = "2"\ntauri-plugin-updater = "2.10.1"',
        )
    cargo_path.write_text(cargo, encoding="utf-8")


def update_tauri_config() -> None:
    path = ROOT / "src-tauri" / "tauri.conf.json"
    config = json.loads(path.read_text(encoding="utf-8"))
    config["version"] = "0.4.0"

    bundle = config.setdefault("bundle", {})
    bundle["createUpdaterArtifacts"] = True

    plugins = config.setdefault("plugins", {})
    updater = plugins.setdefault("updater", {})
    updater["pubkey"] = updater.get("pubkey") or PLACEHOLDER
    updater["endpoints"] = [
        f"https://github.com/{REPO}/releases/latest/download/latest.json"
    ]
    updater["windows"] = {"installMode": "passive"}

    write_json(path, config)


def update_rust_runtime() -> None:
    path = ROOT / "src-tauri" / "src" / "lib.rs"
    source = path.read_text(encoding="utf-8")

    if "use tauri_plugin_updater::UpdaterExt;" not in source:
        anchor = "use tauri::Emitter;\n"
        if anchor not in source:
            raise RuntimeError("Unable to find tauri::Emitter import anchor")
        source = source.replace(
            anchor,
            anchor + "use tauri_plugin_updater::UpdaterExt;\n",
            1,
        )

    update_fn = '''\n#[cfg(desktop)]\nasync fn install_available_update(app: tauri::AppHandle) -> Result<(), String> {\n    let updater = app\n        .updater()\n        .map_err(|error| format!("Unable to initialize updater: {error}"))?;\n    let Some(update) = updater\n        .check()\n        .await\n        .map_err(|error| format!("Update check failed: {error}"))?\n    else {\n        return Ok(());\n    };\n\n    update\n        .download_and_install(|_, _| {}, || {})\n        .await\n        .map_err(|error| format!("Update installation failed: {error}"))?;\n    app.restart();\n}\n'''

    run_anchor = "\n#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {"
    if "async fn install_available_update" not in source:
        if run_anchor not in source:
            raise RuntimeError("Unable to find run() anchor")
        source = source.replace(run_anchor, update_fn + run_anchor, 1)

    old_builder = '''pub fn run() {\n    tauri::Builder::default()\n        .plugin(tauri_plugin_dialog::init())\n        .invoke_handler(tauri::generate_handler![\n'''
    new_builder = '''pub fn run() {\n    tauri::Builder::default()\n        .plugin(tauri_plugin_dialog::init())\n        .setup(|app| {\n            #[cfg(desktop)]\n            app.handle()\n                .plugin(tauri_plugin_updater::Builder::new().build())?;\n\n            #[cfg(all(desktop, not(debug_assertions)))]\n            {\n                let handle = app.handle().clone();\n                tauri::async_runtime::spawn(async move {\n                    if let Err(error) = install_available_update(handle).await {\n                        eprintln!("NAS VocRep updater: {error}");\n                    }\n                });\n            }\n\n            Ok(())\n        })\n        .invoke_handler(tauri::generate_handler![\n'''

    if ".plugin(tauri_plugin_updater::Builder::new().build())" not in source:
        if old_builder not in source:
            raise RuntimeError("Unable to find Tauri builder anchor")
        source = source.replace(old_builder, new_builder, 1)

    path.write_text(source, encoding="utf-8")


def update_readme() -> None:
    path = ROOT / "README.md"
    text = path.read_text(encoding="utf-8")
    marker = "## Updates and releases"
    if marker in text:
        return

    text += '''\n\n## Updates and releases\n\nV04 introduces the Tauri signed updater path for Windows. Release builds check the repository's `latest.json` feed on startup; when a newer signed version is available, NAS VocRep downloads and installs it and restarts the app. GitHub Actions builds the signed NSIS updater artifact and publishes the release assets automatically, so users do not need to manually download and run a new installer for each version.\n\nThe updater signing private key must remain in GitHub Actions secrets. The matching public key is embedded in `src-tauri/tauri.conf.json`.\n'''
    path.write_text(text, encoding="utf-8")


def main() -> None:
    update_versions()
    update_tauri_config()
    update_rust_runtime()
    update_readme()


if __name__ == "__main__":
    main()
