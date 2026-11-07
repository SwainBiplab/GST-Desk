//! Offline AI on the desktop (prompt 36): model files under `<data>/models`, and the sidecar servers
//! (llama.cpp, whisper.cpp, OCR) started from the runtime bundle the model manager downloaded.
//! The real code is compiled only with `--features ai`; without it every command answers `not_built`.
//!
//! UNVERIFIED: this file could not be compiled on the machine it was written on (no webkit2gtk). Build and
//! try it with `cargo tauri dev --features ai` before relying on it. See docs/runbooks/offline-ai.md.

#[cfg(feature = "ai")]
mod real {
    use std::{
        collections::HashMap,
        fs,
        io::{Read, Seek, SeekFrom, Write},
        net::TcpListener,
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        sync::Mutex,
        time::{Duration, Instant},
    };

    use base64::Engine;
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use tauri::{AppHandle, Manager, State};

    use crate::paths;

    #[derive(Default)]
    pub struct AiState {
        sidecars: Mutex<HashMap<String, Running>>,
    }

    struct Running {
        child: Child,
        base_url: String,
        model: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Hardware {
        pub ram_gb: f64,
        pub cores: usize,
        pub gpu: String,
        pub os: String,
        pub arch: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DirEntry {
        pub name: String,
        pub size: u64,
        pub modified: u64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Started {
        pub base_url: String,
    }

    fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
        let root = PathBuf::from(paths::current(app)?.root);
        let dir = root.join("models");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    /// A file name inside the models folder: no separators, no `..`.
    fn safe(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
        if file.is_empty()
            || file.contains('/')
            || file.contains('\\')
            || file.contains("..")
            || file.starts_with('.')
        {
            return Err("bad file name".into());
        }
        Ok(models_dir(app)?.join(file))
    }

    #[tauri::command]
    pub fn ai_models_dir(app: AppHandle) -> Result<String, String> {
        Ok(models_dir(&app)?.display().to_string())
    }

    #[tauri::command]
    pub fn ai_file_size(app: AppHandle, file: String) -> Result<Option<u64>, String> {
        let p = safe(&app, &file)?;
        Ok(fs::metadata(p).ok().map(|m| m.len()))
    }

    #[tauri::command]
    pub fn ai_append(app: AppHandle, file: String, base64: String) -> Result<(), String> {
        let p = safe(&app, &file)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64)
            .map_err(|e| e.to_string())?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn ai_remove(app: AppHandle, file: String) -> Result<(), String> {
        let p = safe(&app, &file)?;
        match fs::remove_file(p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    #[tauri::command]
    pub fn ai_finish(app: AppHandle, partial: String, file: String) -> Result<(), String> {
        let from = safe(&app, &partial)?;
        let to = safe(&app, &file)?;
        fs::rename(from, &to).map_err(|e| e.to_string())?;
        // a runtime bundle is a zip: unpack it beside the file so the binaries can be started
        if file.ends_with(".zip") {
            unzip(&to)?;
        }
        Ok(())
    }

    fn unzip(archive: &Path) -> Result<(), String> {
        let f = fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
        let dest = archive.with_extension("");
        fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        for i in 0..z.len() {
            let mut entry = z.by_index(i).map_err(|e| e.to_string())?;
            let Some(rel) = entry.enclosed_name() else {
                continue;
            };
            let out = dest.join(rel);
            if entry.is_dir() {
                fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut w = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = entry.unix_mode() {
                    let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode));
                }
            }
        }
        Ok(())
    }

    #[tauri::command]
    pub fn ai_sha256(app: AppHandle, file: String) -> Result<String, String> {
        let p = safe(&app, &file)?;
        let mut f = fs::File::open(p).map_err(|e| e.to_string())?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
    }

    #[tauri::command]
    pub fn ai_read_text(app: AppHandle, file: String) -> Result<Option<String>, String> {
        let p = safe(&app, &file)?;
        match fs::read_to_string(p) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    #[tauri::command]
    pub fn ai_write_text(app: AppHandle, file: String, text: String) -> Result<(), String> {
        let p = safe(&app, &file)?;
        let tmp = p.with_extension("tmp");
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(tmp, p).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn ai_free_bytes(app: AppHandle) -> Result<Option<u64>, String> {
        let dir = models_dir(&app)?;
        Ok(fs2_available(&dir))
    }

    #[cfg(unix)]
    fn fs2_available(dir: &Path) -> Option<u64> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c = CString::new(dir.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        Some(st.f_bavail as u64 * st.f_frsize as u64)
    }

    #[cfg(not(unix))]
    fn fs2_available(_dir: &Path) -> Option<u64> {
        None
    }

    /// A folder the person chose to watch: listed, never written.
    #[tauri::command]
    pub fn ai_list_dir(dir: String) -> Result<Vec<DirEntry>, String> {
        let mut out = vec![];
        for e in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            let m = e.metadata().map_err(|e| e.to_string())?;
            if !m.is_file() {
                continue;
            }
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(DirEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                size: m.len(),
                modified,
            });
        }
        Ok(out)
    }

    #[tauri::command]
    pub fn ai_read_file(path: String) -> Result<tauri::ipc::Response, String> {
        let p = PathBuf::from(&path);
        if !matches!(
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .as_deref(),
            Some("png" | "jpg" | "jpeg" | "webp" | "pdf")
        ) {
            return Err("only images and PDFs can be read".into());
        }
        let bytes = fs::read(p).map_err(|e| e.to_string())?;
        if bytes.len() > 10 * 1024 * 1024 {
            return Err("file is over 10 MB".into());
        }
        Ok(tauri::ipc::Response::new(bytes))
    }

    #[tauri::command]
    pub fn ai_hardware() -> Hardware {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let ram_gb = (sys.total_memory() as f64 / (1u64 << 30) as f64 * 10.0).round() / 10.0;
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2);
        let gpu = if cfg!(target_os = "macos") {
            "metal"
        } else if Path::new("/usr/lib/x86_64-linux-gnu/libvulkan.so.1").exists()
            || Path::new("C:\\Windows\\System32\\vulkan-1.dll").exists()
        {
            "vulkan"
        } else {
            "unknown"
        };
        Hardware {
            ram_gb,
            cores,
            gpu: gpu.into(),
            os: match std::env::consts::OS {
                "macos" => "macos",
                "windows" => "windows",
                _ => "linux",
            }
            .into(),
            arch: match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                _ => "unknown",
            }
            .into(),
        }
    }

    fn free_port() -> Result<u16, String> {
        let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        Ok(l.local_addr().map_err(|e| e.to_string())?.port())
    }

    /// The binary for a sidecar kind inside the unpacked runtime bundle.
    fn binary(app: &AppHandle, kind: &str) -> Result<PathBuf, String> {
        let dir = models_dir(app)?;
        let name = match kind {
            "llama" => "llama-server",
            "whisper" => "whisper-server",
            "ocr" => "gst-ocr-server",
            _ => return Err("unknown sidecar".into()),
        };
        let exe = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
            let p = entry.path();
            if p.is_dir() {
                for cand in [
                    p.join(&exe),
                    p.join("bin").join(&exe),
                    p.join("build").join("bin").join(&exe),
                ] {
                    if cand.exists() {
                        return Ok(cand);
                    }
                }
            }
        }
        Err(format!(
            "{name} is not downloaded: get the runtime bundle in Settings, AI"
        ))
    }

    fn wait_health(base_url: &str, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if let Ok(r) = reqwest::blocking::Client::new()
                .get(format!("{base_url}/health"))
                .timeout(Duration::from_secs(2))
                .send()
            {
                if r.status().is_success() {
                    return Ok(());
                }
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        Err("the server did not come up in time".into())
    }

    #[tauri::command]
    pub fn sidecar_start(
        app: AppHandle,
        state: State<'_, AiState>,
        kind: String,
        model_file: String,
        threads: Option<usize>,
    ) -> Result<Started, String> {
        let mut map = state.sidecars.lock().unwrap();
        if let Some(r) = map.get_mut(&kind) {
            if r.model == model_file {
                if let Ok(None) = r.child.try_wait() {
                    return Ok(Started {
                        base_url: r.base_url.clone(),
                    });
                }
            }
            let _ = r.child.kill();
            map.remove(&kind);
        }
        let model = safe(&app, &model_file)?;
        if !model.exists() {
            return Err("the model file is missing".into());
        }
        let exe = binary(&app, &kind)?;
        let port = free_port()?;
        let threads = threads.unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get().saturating_sub(1).max(1))
                .unwrap_or(2)
        });
        let mut cmd = Command::new(&exe);
        match kind.as_str() {
            "llama" => {
                cmd.args(["-m"]).arg(&model).args([
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                    "-t",
                    &threads.to_string(),
                    "-c",
                    "4096",
                    "--embedding",
                    "--log-disable",
                ]);
            }
            "whisper" => {
                cmd.args(["-m"]).arg(&model).args([
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                    "-t",
                    &threads.to_string(),
                ]);
            }
            _ => {
                cmd.args(["--model"]).arg(&model).args([
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                ]);
            }
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(dir) = exe.parent() {
            cmd.current_dir(dir);
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", exe.display()))?;
        let base_url = format!("http://127.0.0.1:{port}");
        if let Err(e) = wait_health(&base_url, Duration::from_secs(90)) {
            let mut child = child;
            let _ = child.kill();
            return Err(e);
        }
        map.insert(
            kind,
            Running {
                child,
                base_url: base_url.clone(),
                model: model_file,
            },
        );
        Ok(Started { base_url })
    }

    #[tauri::command]
    pub fn sidecar_stop(state: State<'_, AiState>, kind: String) -> Result<(), String> {
        if let Some(mut r) = state.sidecars.lock().unwrap().remove(&kind) {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
        Ok(())
    }

    /// Stop everything when the app closes, so no server outlives it.
    pub fn stop_all(state: &AiState) {
        for (_, mut r) in state.sidecars.lock().unwrap().drain() {
            let _ = r.child.kill();
        }
    }

    // keep the unused-import lints quiet on platforms that do not use every path
    #[allow(dead_code)]
    fn _unused(_: &mut fs::File) -> std::io::Result<u64> {
        let mut f = fs::File::open("/dev/null")?;
        f.seek(SeekFrom::Start(0))
    }
}

#[cfg(feature = "ai")]
pub use real::*;

#[cfg(not(feature = "ai"))]
mod real {
    #[derive(Default)]
    pub struct AiState;

    const OFF: &str = "not_built: this build of GST Desk does not include offline AI";

    #[tauri::command]
    pub fn ai_models_dir() -> Result<String, String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn ai_file_size(_file: String) -> Result<Option<u64>, String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn ai_append(_file: String, _base64: String) -> Result<(), String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn ai_remove(_file: String) -> Result<(), String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn ai_finish(_partial: String, _file: String) -> Result<(), String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn ai_sha256(_file: String) -> Result<String, String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn ai_read_text(_file: String) -> Result<Option<String>, String> {
        Ok(None)
    }
    #[tauri::command]
    pub fn ai_write_text(_file: String, _text: String) -> Result<(), String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn ai_free_bytes() -> Result<Option<u64>, String> {
        Ok(None)
    }
    #[tauri::command]
    pub fn ai_list_dir(_dir: String) -> Result<Vec<()>, String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn ai_read_file(_path: String) -> Result<Vec<u8>, String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn ai_hardware() -> Result<(), String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn sidecar_start(
        _kind: String,
        _model_file: String,
        _threads: Option<usize>,
    ) -> Result<(), String> {
        Err(OFF.into())
    }
    #[tauri::command]
    pub fn sidecar_stop(_kind: String) -> Result<(), String> {
        Ok(())
    }
    pub fn stop_all(_state: &AiState) {}
}

#[cfg(not(feature = "ai"))]
pub use real::*;
