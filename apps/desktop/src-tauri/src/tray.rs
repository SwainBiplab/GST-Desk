//! The tray icon and its menu: quick actions that work with the window hidden or behind others.
//! The labels are set by the page (in the language of the screens) through `set_tray_labels`; until
//! then they are English.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

pub const ITEMS: [(&str, &str); 5] = [
    ("new-bill", "New bill"),
    ("backup-now", "Back up now"),
    ("open-data", "Open data folder"),
    ("show", "Show GST Desk"),
    ("quit", "Quit"),
];

#[derive(Default)]
pub struct TrayItems(Mutex<HashMap<String, MenuItem<tauri::Wry>>>);

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn build(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mut items = HashMap::new();
    let menu = Menu::new(app)?;
    for (i, (id, label)) in ITEMS.iter().enumerate() {
        if i == 3 {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        let item = MenuItem::with_id(app, *id, *label, true, None::<&str>)?;
        menu.append(&item)?;
        items.insert((*id).to_string(), item);
    }
    app.manage(TrayItems(Mutex::new(items)));
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("GST Desk")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            "show" => show_main(app),
            "open-data" => {
                let _ = crate::paths::current(app).and_then(|p| crate::paths::open_in_file_manager(std::path::Path::new(&p.root)));
            }
            id @ ("new-bill" | "backup-now") => {
                show_main(app);
                let _ = app.emit(&format!("tray:{id}"), ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// The page tells the tray what to say, in its language. Unknown ids are ignored.
#[tauri::command]
pub fn set_tray_labels(items: tauri::State<'_, TrayItems>, labels: HashMap<String, String>) -> Result<(), String> {
    let map = items.0.lock().map_err(|_| "lock")?;
    for (id, label) in labels {
        if let Some(item) = map.get(&id) {
            item.set_text(label).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_has_the_quick_actions_with_distinct_ids() {
        let ids: Vec<_> = ITEMS.iter().map(|i| i.0).collect();
        for want in ["new-bill", "backup-now", "open-data", "show", "quit"] {
            assert!(ids.contains(&want));
        }
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len());
    }
}
