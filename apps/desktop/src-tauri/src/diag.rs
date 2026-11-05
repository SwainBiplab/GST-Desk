//! "Report a problem": a ZIP the person can send to support. It holds the app's log files and a short
//! description of the machine, with anything that looks like a person's or a business's details taken
//! out of the logs. It never contains the database, backups, documents or settings.

use regex::Regex;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;

struct Patterns {
    email: Regex,
    gstin: Regex,
    pan: Regex,
    uuid: Regex,
    digits: Regex,
    user_path: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        email: Regex::new(r"[\w.+-]+@[\w-]+(\.[\w-]+)+").unwrap(),
        gstin: Regex::new(r"\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b").unwrap(),
        pan: Regex::new(r"\b[A-Z]{5}\d{4}[A-Z]\b").unwrap(),
        uuid: Regex::new(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b").unwrap(),
        digits: Regex::new(r"\d{9,}").unwrap(),
        user_path: Regex::new(r"(?i)(users[\\/]|home[\\/])[^\\/\s]+").unwrap(),
    })
}

/// Remove identifiers from a line of log text.
pub fn scrub(text: &str) -> String {
    let p = patterns();
    let t = p.email.replace_all(text, "<email>");
    let t = p.gstin.replace_all(&t, "<gstin>");
    let t = p.pan.replace_all(&t, "<pan>");
    let t = p.uuid.replace_all(&t, "<id>");
    let t = p.digits.replace_all(&t, "<number>");
    p.user_path.replace_all(&t, "${1}<user>").into_owned()
}

/// The newest log files, newest first, at most `keep`.
fn newest_logs(dir: &Path, keep: usize) -> Vec<std::path::PathBuf> {
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "log"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().take(keep).map(|f| f.1).collect()
}

pub fn build_zip(dest: &Path, logs: &Path, version: &str, extra: &str) -> Result<usize, String> {
    let file = fs::File::create(dest).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let info = format!(
        "GST Desk {version}\nOS: {} {}\nFamily: {}\n\n{extra}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::consts::FAMILY
    );
    zip.start_file("info.txt", opts).map_err(|e| e.to_string())?;
    zip.write_all(info.as_bytes()).map_err(|e| e.to_string())?;
    let mut n = 0;
    for path in newest_logs(logs, 5) {
        // a log can hold a line cut mid-character; lossy conversion keeps the rest readable
        let raw = fs::read(&path).map_err(|e| e.to_string())?;
        let text = scrub(&String::from_utf8_lossy(&raw));
        let name = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        zip.start_file(format!("logs/{name}"), opts).map_err(|e| e.to_string())?;
        zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        n += 1;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(n)
}

/// Save the diagnostics ZIP to `dest` (the person picked it in a save dialog).
#[tauri::command(async)]
pub fn diagnostics_zip(app: tauri::AppHandle, dest: String, extra: Option<String>) -> Result<usize, String> {
    use tauri::Manager;
    let logs = app.path().app_log_dir().map_err(|e| e.to_string())?;
    build_zip(Path::new(&dest), &logs, &app.package_info().version.to_string(), &scrub(&extra.unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn it_takes_identifiers_out_of_a_line() {
        let line = "party 3f2b8c1e-0a4d-4b6f-9d6e-1a2b3c4d5e6f a@b.co 27AAPFU0939F1ZV AAPFU0939F acct 123456789012 C:\\Users\\Biplab\\x.db /home/raj/y";
        let out = scrub(line);
        for bad in ["3f2b8c1e", "a@b.co", "27AAPFU0939F1ZV", "AAPFU0939F", "123456789012", "Biplab", "raj"] {
            assert!(!out.contains(bad), "{bad} survived: {out}");
        }
        assert!(out.contains("<gstin>") && out.contains("<email>") && out.contains("<user>"));
        // ordinary numbers and words are left alone
        assert_eq!(scrub("took 420 ms for 12 rows"), "took 420 ms for 12 rows");
    }

    #[test]
    fn the_zip_has_scrubbed_logs_and_no_data() {
        let base = std::env::temp_dir().join(format!("gstdesk-diag-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let logs = base.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join("a.log"), "opened for owner@shop.in with GSTIN 27AAPFU0939F1ZV").unwrap();
        fs::write(base.join("gst-desk.db"), "SECRET BUSINESS DATA").unwrap();
        let dest = base.join("out.zip");
        let n = build_zip(&dest, &logs, "1.2.3", "").unwrap();
        assert_eq!(n, 1);
        let mut z = zip::ZipArchive::new(fs::File::open(&dest).unwrap()).unwrap();
        let names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().unwrap().to_string()).collect();
        assert!(names.contains(&"info.txt".to_string()) && names.contains(&"logs/a.log".to_string()));
        assert!(!names.iter().any(|n| n.contains("db")));
        let mut log = String::new();
        z.by_name("logs/a.log").unwrap().read_to_string(&mut log).unwrap();
        assert!(!log.contains("owner@shop.in") && !log.contains("27AAPFU0939F1ZV"));
        let mut info = String::new();
        z.by_name("info.txt").unwrap().read_to_string(&mut info).unwrap();
        assert!(info.contains("GST Desk 1.2.3"));
        let _ = fs::remove_dir_all(base);
    }
}
