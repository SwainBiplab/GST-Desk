//! Secrets in the operating system's keychain (prompt 48): a person's own cloud AI key lives in Keychain,
//! Credential Manager or the Secret Service, never in the book, a backup or a log. Names are a short
//! allow-list so the page cannot read or write arbitrary entries.

const SERVICE: &str = "gst-desk";
const ALLOWED: &[&str] = &["anthropic_api_key"];

fn entry(name: &str) -> Result<keyring::Entry, String> {
    if !ALLOWED.contains(&name) {
        return Err("unknown secret".into());
    }
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 {
        return Err("a secret is between 1 and 512 characters".into());
    }
    entry(&name)?.set_password(value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
