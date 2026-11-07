mod ai;
mod db;
mod diag;
mod lan;
mod launch;
mod paths;
mod printers;
mod tray;
mod update;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch_args: Vec<String> = std::env::args().collect();
    tauri::Builder::default()
        // first: a second launch hands its arguments to the running app and exits
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            launch::push(app, launch::parse_args(&args));
            // launching again with nothing to open still brings the window forward
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                // rotating files: 1 MB each, the newest five kept
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .build(),
        )
        .manage(db::DbState::default())
        .manage(launch::Queue::default())
        .manage(update::Pending::default())
        .manage(lan::LanState::default())
        .manage(ai::AiState::default())
        .invoke_handler(tauri::generate_handler![
            db::db_open,
            db::db_exec,
            db::db_close,
            paths::data_paths,
            paths::open_data_dir,
            paths::move_data,
            paths::remove_restore_dir,
            printers::list_printers,
            diag::diagnostics_zip,
            update::update_check,
            update::update_download,
            update::update_install,
            launch::take_launch_requests,
            launch::read_backup_file,
            tray::set_tray_labels,
            lan::lan_start,
            lan::lan_stop,
            lan::lan_reply,
            ai::ai_models_dir,
            ai::ai_file_size,
            ai::ai_append,
            ai::ai_remove,
            ai::ai_finish,
            ai::ai_sha256,
            ai::ai_read_text,
            ai::ai_write_text,
            ai::ai_free_bytes,
            ai::ai_list_dir,
            ai::ai_read_file,
            ai::ai_hardware,
            ai::sidecar_start,
            ai::sidecar_stop,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // a backup or link the app was started with
            launch::push(&handle, launch::parse_args(&launch_args));
            // links that arrive while the app runs
            let h = handle.clone();
            app.deep_link().on_open_url(move |event| {
                let links = event
                    .urls()
                    .iter()
                    .map(|u| launch::Request::Link(u.to_string()))
                    .collect();
                launch::push(&h, links);
            });
            // linux and windows development builds register the scheme at run time; installers do it for releases
            #[cfg(any(windows, target_os = "linux"))]
            if cfg!(debug_assertions) {
                let _ = app.deep_link().register_all();
            }
            // launched at login: start in the tray, not in front of the person
            if launch_args.iter().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building GST Desk")
        .run(|app, event| {
            // no model server outlives the app
            if let tauri::RunEvent::Exit = event {
                ai::stop_all(&app.state::<ai::AiState>());
            }
        });
}
