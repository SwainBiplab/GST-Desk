//! Updates. The check, the background download and the restart are three steps so the screen can show
//! each one: a person is told an update is ready and chooses when to restart; the app never restarts
//! under them. A signed `latest.json` is what `tauri-plugin-updater` verifies against the public key
//! in `tauri.conf.json` (an update whose signature does not verify is refused, and nothing is
//! installed). The channel (stable or beta) chooses which manifest to read.

use serde::Serialize;
use std::sync::Mutex;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
pub struct Pending {
    update: Mutex<Option<tauri_plugin_updater::Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// The manifest address for a channel. Stable reads the address as configured; beta reads `beta/` beside it.
pub fn channel_url(endpoint: &str, channel: &str) -> String {
    if channel != "beta" {
        return endpoint.to_string();
    }
    match endpoint.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/beta/{file}"),
        None => endpoint.to_string(),
    }
}

fn configured_endpoint(app: &tauri::AppHandle) -> Option<String> {
    let conf = app.config().plugins.0.get("updater")?;
    conf.get("endpoints")?.as_array()?.first()?.as_str().map(str::to_string)
}

/// Check for an update. A debug build may point at a local mock server with `base_url`; a release
/// build ignores it, so nothing a page does can redirect where updates come from.
#[tauri::command(async)]
pub async fn update_check(
    app: tauri::AppHandle,
    pending: tauri::State<'_, Pending>,
    channel: String,
    base_url: Option<String>,
) -> Result<Option<UpdateInfo>, String> {
    let endpoint = if cfg!(debug_assertions) { base_url.or_else(|| configured_endpoint(&app)) } else { configured_endpoint(&app) };
    let endpoint = endpoint.ok_or("no update address is set")?;
    let url = channel_url(&endpoint, &channel);
    let updater = app
        .updater_builder()
        .endpoints(vec![url.parse().map_err(|e| format!("bad update address: {e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    *pending.bytes.lock().map_err(|_| "lock")? = None;
    match found {
        Some(u) => {
            let info = UpdateInfo {
                version: u.version.clone(),
                current: u.current_version.clone(),
                notes: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
            };
            *pending.update.lock().map_err(|_| "lock")? = Some(u);
            Ok(Some(info))
        }
        None => {
            *pending.update.lock().map_err(|_| "lock")? = None;
            Ok(None)
        }
    }
}

/// Download the update that was found, in the background, telling the page how far it is. The
/// signature is checked by the plugin when it installs.
#[tauri::command(async)]
pub async fn update_download(app: tauri::AppHandle, pending: tauri::State<'_, Pending>) -> Result<(), String> {
    let update = pending.update.lock().map_err(|_| "lock")?.clone().ok_or("there is no update to download")?;
    let mut done: u64 = 0;
    let handle = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                done += chunk as u64;
                let _ = handle.emit("update:progress", serde_json::json!({ "done": done, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    *pending.bytes.lock().map_err(|_| "lock")? = Some(bytes);
    let _ = app.emit("update:ready", ());
    Ok(())
}

/// Keep a copy of the version that is running, so a bad update can be rolled back by hand.
fn keep_previous(app: &tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = crate::paths::current(app)?.root;
    let dir = std::path::Path::new(&root).join("previous").join(app.package_info().version.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = exe.file_name().ok_or("no executable name")?;
    std::fs::copy(&exe, dir.join(name)).map_err(|e| e.to_string())?;
    // only the last two versions are kept
    let parent = dir.parent().ok_or("no folder")?;
    let mut versions: Vec<_> = std::fs::read_dir(parent).map_err(|e| e.to_string())?.flatten().filter(|e| e.path().is_dir()).collect();
    versions.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    while versions.len() > 2 {
        let old = versions.remove(0);
        let _ = std::fs::remove_dir_all(old.path());
    }
    Ok(())
}

/// Install the downloaded update and restart into it. Called when the person presses "Restart to update".
#[tauri::command(async)]
pub fn update_install(app: tauri::AppHandle, pending: tauri::State<'_, Pending>, db: tauri::State<'_, crate::db::DbState>) -> Result<(), String> {
    let update = pending.update.lock().map_err(|_| "lock")?.clone().ok_or("there is no update")?;
    let bytes = pending.bytes.lock().map_err(|_| "lock")?.take().ok_or("the update has not finished downloading")?;
    // best effort: a failed copy must not stop an update
    if let Err(e) = keep_previous(&app) {
        log::warn!("could not keep the previous version: {e}");
    }
    // close the database cleanly (checkpointing it) before the new version opens the same file
    crate::db::close_named(&db, crate::db::MAIN)?;
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_reads_the_address_as_given_and_beta_reads_beta_beside_it() {
        let e = "https://updates.example.com/gstdesk/latest.json";
        assert_eq!(channel_url(e, "stable"), e);
        assert_eq!(channel_url(e, "anything-else"), e);
        assert_eq!(channel_url(e, "beta"), "https://updates.example.com/gstdesk/beta/latest.json");
        assert_eq!(channel_url("latest.json", "beta"), "latest.json");
    }
}
