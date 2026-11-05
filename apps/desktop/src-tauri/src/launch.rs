//! Things the system asks the app to open: a `.gstbk` backup double-clicked in the file manager, and a
//! `gstdesk://` link. They arrive at launch (in the command line) or while the app is running (the
//! single-instance lock hands the second launch's arguments to the first). Each becomes a request the
//! page takes when it is ready, so one that arrives before the page has loaded is not lost.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Request {
    /// A backup file to offer to restore.
    File(String),
    /// A `gstdesk://` link.
    Link(String),
}

#[derive(Default)]
pub struct Queue(pub Mutex<Vec<Request>>);

pub const SCHEME: &str = "gstdesk";

/// Turn command-line arguments into requests: the first is the program, the rest are files or links.
pub fn parse_args(args: &[String]) -> Vec<Request> {
    args.iter()
        .skip(1)
        .filter_map(|a| {
            let lower = a.to_lowercase();
            if lower.starts_with(&format!("{SCHEME}://")) {
                Some(Request::Link(a.clone()))
            } else if lower.ends_with(".gstbk") {
                Some(Request::File(a.clone()))
            } else {
                None
            }
        })
        .collect()
}

pub fn push(app: &tauri::AppHandle, requests: Vec<Request>) {
    if requests.is_empty() {
        return;
    }
    if let Some(q) = app.try_state::<Queue>() {
        if let Ok(mut v) = q.0.lock() {
            v.extend(requests);
        }
    }
    let _ = app.emit("launch:request", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn take_launch_requests(q: tauri::State<'_, Queue>) -> Vec<Request> {
    q.0.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default()
}

/// Read a backup the system gave us. Only a `.gstbk` can be read this way, so a page cannot use it to
/// read other files.
#[tauri::command(async)]
pub fn read_backup_file(path: String) -> Result<tauri::ipc::Response, String> {
    if !path.to_lowercase().ends_with(".gstbk") {
        return Err("only a GST Desk backup (.gstbk) can be opened".into());
    }
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("cannot read the backup: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn it_finds_backups_and_links_and_ignores_the_rest() {
        let got = parse_args(&s(&["gst-desk.exe", "C:\\b\\Shop-2026.GSTBK", "gstdesk://inbox", "--minimized", "notes.txt"]));
        assert_eq!(
            got,
            vec![Request::File("C:\\b\\Shop-2026.GSTBK".into()), Request::Link("gstdesk://inbox".into())]
        );
        assert!(parse_args(&s(&["gst-desk.exe"])).is_empty());
        // the program name itself is never taken for a file
        assert!(parse_args(&s(&["x.gstbk"])).is_empty());
    }

    #[test]
    fn only_backups_can_be_read() {
        assert!(read_backup_file("C:\\Windows\\win.ini".into()).is_err());
        assert!(read_backup_file("/etc/passwd".into()).is_err());
    }
}
