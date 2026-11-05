//! Where the app keeps things, and the wizard that moves them.
//!
//! The default folder is the user's own, so no admin rights are needed and a per-user install can be
//! removed without touching it:
//!
//! | OS      | Data folder                                  |
//! | ------- | -------------------------------------------- |
//! | Windows | `%APPDATA%\GST Desk`                         |
//! | macOS   | `~/Library/Application Support/GST Desk`     |
//! | Linux   | `~/.local/share/gst-desk`                    |
//!
//! Inside it: `data/` (the database), `backups/`, and `location.json` which says where the folder was
//! moved to if the person moved it. That pointer always lives in the default folder, so the app can
//! find a moved folder on the next start. Documents (PDFs the person saves) go under the user's
//! Documents folder in `GST Desk`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub const DB_FILE: &str = "gst-desk.sqlite3";

/// The default folder under the OS's per-user data directory.
pub fn default_root(os: &str, data_dir: &Path) -> PathBuf {
    match os {
        "linux" => data_dir.join("gst-desk"),
        _ => data_dir.join("GST Desk"),
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Pointer {
    root: Option<String>,
}

fn pointer_path(default: &Path) -> PathBuf {
    default.join("location.json")
}

/// The folder in use: the one the person moved to, if there is one and it still exists.
pub fn resolve_root(default: &Path) -> PathBuf {
    let moved = fs::read_to_string(pointer_path(default))
        .ok()
        .and_then(|s| serde_json::from_str::<Pointer>(&s).ok())
        .and_then(|p| p.root)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir());
    moved.unwrap_or_else(|| default.to_path_buf())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DataPaths {
    pub root: String,
    pub db: String,
    pub backups: String,
    pub documents: String,
    pub logs: String,
    pub is_default: bool,
}

pub fn paths_for(root: &Path, default: &Path, documents: &Path, logs: &Path) -> DataPaths {
    DataPaths {
        root: root.display().to_string(),
        db: root.join("data").join(DB_FILE).display().to_string(),
        backups: root.join("backups").display().to_string(),
        documents: documents.join("GST Desk").display().to_string(),
        logs: logs.display().to_string(),
        is_default: root == default,
    }
}

fn default_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // A debug build can be pointed at a scratch folder, so automated tests never touch a real person's data.
    // A release build ignores this, so nothing in the environment can redirect where data is kept.
    if cfg!(debug_assertions) {
        if let Ok(dir) = std::env::var("GSTDESK_DATA_DIR") {
            if !dir.is_empty() {
                return Ok(PathBuf::from(dir));
            }
        }
    }
    let base = app.path().data_dir().map_err(|e| e.to_string())?;
    Ok(default_root(std::env::consts::OS, &base))
}

pub fn current(app: &tauri::AppHandle) -> Result<DataPaths, String> {
    let default = default_for(app)?;
    let root = resolve_root(&default);
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    let logs = app.path().app_log_dir().map_err(|e| e.to_string())?;
    Ok(paths_for(&root, &default, &docs, &logs))
}

/* ------------------------------------------------------------------ moving the folder */

fn walk(dir: &Path, out: &mut Vec<(PathBuf, u64)>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_dir() {
            walk(&entry.path(), out)?;
        } else {
            out.push((entry.path(), meta.len()));
        }
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.metadata()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// (file count, total bytes) of everything under a folder, for checking a copy.
pub fn tally(dir: &Path) -> std::io::Result<(usize, u64)> {
    let mut files = Vec::new();
    if dir.exists() {
        walk(dir, &mut files)?;
    }
    Ok((files.len(), files.iter().map(|f| f.1).sum()))
}

/// Why a folder cannot be moved to, or `None` when it can.
pub fn refuse_target(current: &Path, target: &Path) -> Option<&'static str> {
    if !target.is_absolute() {
        return Some("choose a full folder path");
    }
    if target == current {
        return Some("that is the folder already in use");
    }
    if target.starts_with(current) || current.starts_with(target) {
        return Some("the new folder cannot be inside the old one, or hold it");
    }
    if target.exists() {
        let empty = fs::read_dir(target).map(|mut d| d.next().is_none()).unwrap_or(false);
        if !empty {
            return Some("the new folder must be empty");
        }
    }
    None
}

/// Copy `data/` and `backups/` to `target`, check the copy is complete, and only then point the app at
/// it. The old folder is left where it is: the person removes it once they have looked.
pub fn move_root(current: &Path, default: &Path, target: &Path) -> Result<(), String> {
    if let Some(why) = refuse_target(current, target) {
        return Err(why.to_string());
    }
    fs::create_dir_all(target).map_err(|e| format!("cannot create the new folder: {e}"))?;
    for sub in ["data", "backups"] {
        let from = current.join(sub);
        if from.exists() {
            copy_dir(&from, &target.join(sub)).map_err(|e| format!("copy failed: {e}"))?;
            let a = tally(&from).map_err(|e| e.to_string())?;
            let b = tally(&target.join(sub)).map_err(|e| e.to_string())?;
            if a != b {
                return Err(format!("the copy of {sub} is not complete ({a:?} against {b:?}); nothing was changed"));
            }
        }
    }
    fs::create_dir_all(default).map_err(|e| e.to_string())?;
    let ptr = serde_json::to_string(&Pointer { root: Some(target.display().to_string()) }).map_err(|e| e.to_string())?;
    // write beside, then rename: the pointer is either the old one or the new one, never half of one
    let tmp = pointer_path(default).with_extension("tmp");
    fs::write(&tmp, ptr).map_err(|e| e.to_string())?;
    fs::rename(&tmp, pointer_path(default)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn data_paths(app: tauri::AppHandle) -> Result<DataPaths, String> {
    current(&app)
}

/// A restore builds its new database in a folder of this shape beside the live one (see the web app's
/// `db-location.ts`); only such folders may be removed from outside.
pub fn is_restore_dir(name: &str) -> bool {
    name.strip_prefix("gst-desk-restore-").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

/// Remove an old restore folder (kept for a week as the way back, then cleaned up).
#[tauri::command(async)]
pub fn remove_restore_dir(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !is_restore_dir(&name) {
        return Err("not a restore folder".into());
    }
    let p = current(&app)?;
    let dir = Path::new(&p.root).join("data").join(&name);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let p = current(&app)?;
    fs::create_dir_all(&p.root).map_err(|e| e.to_string())?;
    open_in_file_manager(Path::new(&p.root))
}

pub fn open_in_file_manager(path: &Path) -> Result<(), String> {
    let (cmd, args): (&str, Vec<String>) = match std::env::consts::OS {
        "windows" => ("explorer", vec![path.display().to_string()]),
        "macos" => ("open", vec![path.display().to_string()]),
        _ => ("xdg-open", vec![path.display().to_string()]),
    };
    // explorer reports a nonzero code even when it worked, so only a failure to start is an error
    std::process::Command::new(cmd).args(args).spawn().map(|_| ()).map_err(|e| format!("cannot open the folder: {e}"))
}

/// Move the data folder. The database is closed first; the page reloads afterwards and opens it again
/// from the new place.
#[tauri::command(async)]
pub fn move_data(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::DbState>,
    target: String,
) -> Result<DataPaths, String> {
    let default = default_for(&app)?;
    let root = resolve_root(&default);
    crate::db::close_named(&db, crate::db::MAIN)?;
    move_root(&root, &default, Path::new(&target))?;
    current(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("gstdesk-paths-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn default_folders_follow_each_systems_convention() {
        assert_eq!(default_root("windows", Path::new("C:/Users/a/AppData/Roaming")), Path::new("C:/Users/a/AppData/Roaming/GST Desk"));
        assert_eq!(default_root("macos", Path::new("/Users/a/Library/Application Support")), Path::new("/Users/a/Library/Application Support/GST Desk"));
        assert_eq!(default_root("linux", Path::new("/home/a/.local/share")), Path::new("/home/a/.local/share/gst-desk"));
    }

    #[test]
    fn only_restore_folders_can_be_removed() {
        assert!(is_restore_dir("gst-desk-restore-1730000000000"));
        assert!(!is_restore_dir("gst-desk-restore-"));
        assert!(!is_restore_dir("gst-desk-restore-1/../x"));
        assert!(!is_restore_dir("gst-desk"));
        assert!(!is_restore_dir(".."));
    }

    #[test]
    fn the_database_sits_in_data_and_documents_under_documents() {
        let p = paths_for(Path::new("/r"), Path::new("/r"), Path::new("/docs"), Path::new("/logs"));
        assert!(p.db.replace('\\', "/").ends_with("/r/data/gst-desk.sqlite3"));
        assert!(p.documents.replace('\\', "/").ends_with("/docs/GST Desk"));
        assert!(p.is_default);
    }

    #[test]
    fn moving_copies_checks_and_points_at_the_new_folder_leaving_the_old_one() {
        let base = tmp("move");
        let default = base.join("default");
        fs::create_dir_all(default.join("data")).unwrap();
        fs::create_dir_all(default.join("backups")).unwrap();
        fs::write(default.join("data").join(DB_FILE), vec![7u8; 5000]).unwrap();
        fs::write(default.join("backups").join("a.gstbk"), b"backup").unwrap();
        let target = base.join("elsewhere");
        move_root(&default, &default, &target).unwrap();
        assert_eq!(tally(&target.join("data")).unwrap(), (1, 5000));
        assert_eq!(tally(&target.join("backups")).unwrap(), (1, 6));
        assert_eq!(resolve_root(&default), target);
        // the old copy stays until the person removes it
        assert!(default.join("data").join(DB_FILE).exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn it_refuses_unsafe_targets_and_changes_nothing() {
        let base = tmp("refuse");
        let root = base.join("root");
        fs::create_dir_all(root.join("data")).unwrap();
        assert!(refuse_target(&root, Path::new("relative/path")).is_some());
        assert!(refuse_target(&root, &root).is_some());
        assert!(refuse_target(&root, &root.join("inside")).is_some());
        assert!(refuse_target(&root, &base).is_some()); // holds the old folder
        let full = base.join("full");
        fs::create_dir_all(&full).unwrap();
        fs::write(full.join("x"), b"1").unwrap();
        assert!(refuse_target(&root, &full).is_some());
        assert!(move_root(&root, &root, &full).is_err());
        assert_eq!(resolve_root(&root), root);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn a_pointer_to_a_folder_that_is_gone_falls_back_to_the_default() {
        let base = tmp("gone");
        let default = base.join("d");
        fs::create_dir_all(&default).unwrap();
        fs::write(pointer_path(&default), r#"{"root":"/no/such/place/anywhere"}"#).unwrap();
        assert_eq!(resolve_root(&default), default);
        fs::write(pointer_path(&default), "not json").unwrap();
        assert_eq!(resolve_root(&default), default);
        let _ = fs::remove_dir_all(base);
    }
}
