//! Tablets and phones on the shop network (prompt 35). The real code is compiled only with `--features lan`.
//!
//! Without the feature the three commands still exist and say so, so the web app can show "not in this build".
//!
//! The server itself lives in `../lan-server` and is tested on its own. This file only connects it to the
//! app: requests are emitted to the window as `lan-request` events, the window answers with `lan_reply`,
//! and the web files are served from the ones inside the program.
//!
//! UNVERIFIED: this glue could not be compiled on the machine it was written on (no webkit2gtk). Build and
//! try it with `cargo tauri dev --features lan` before relying on it. See docs/runbooks/lan-access.md.

#[cfg(feature = "lan")]
mod real {
    use std::{net::SocketAddr, sync::Arc};

    use gst_lan_server::{
        lan_addresses, Asset, AssetFn, ChannelForward, ForwardResponse, LanConfig, LanServer, Route,
    };
    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Emitter, Manager, State};
    use tokio::sync::Mutex;

    #[derive(Default)]
    pub struct LanState {
        running: Mutex<Option<Running>>,
    }

    struct Running {
        server: LanServer,
        forward: Arc<ChannelForward>,
    }

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct RequestEvent {
        id: u64,
        route: &'static str,
        ip: String,
        token: Option<String>,
        body: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct StartArgs {
        pub port: u16,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Started {
        pub port: u16,
        pub fingerprint: String,
        pub addresses: Vec<String>,
    }

    fn route_name(r: Route) -> &'static str {
        match r {
            Route::Ping => "ping",
            Route::Pair => "pair",
            Route::Rpc => "rpc",
        }
    }

    #[tauri::command]
    pub async fn lan_start(
        app: AppHandle,
        state: State<'_, LanState>,
        args: StartArgs,
    ) -> Result<Started, String> {
        let mut slot = state.running.lock().await;
        if slot.is_some() {
            return Err("already running".into());
        }
        let emitter = app.clone();
        let forward = ChannelForward::new(move |id, req| {
            let _ = emitter.emit(
                "lan-request",
                RequestEvent {
                    id,
                    route: route_name(req.route),
                    ip: req.ip.clone(),
                    token: req.token.clone(),
                    body: req.body.clone(),
                },
            );
        });
        let addrs = lan_addresses();
        let mut names: Vec<String> = vec!["gstdesk.local".into(), "localhost".into()];
        names.extend(addrs.iter().map(|a| a.to_string()));
        let cert_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("lan");
        let resolver = app.clone();
        let assets: AssetFn = Arc::new(move |p: &str| {
            resolver.asset_resolver().get(p.to_string()).map(|a| Asset {
                bytes: a.bytes.to_vec(),
                mime: a.mime_type,
            })
        });
        let bind: SocketAddr = ([0, 0, 0, 0], args.port).into();
        let mut cfg = LanConfig::new(bind, std::path::PathBuf::new(), cert_dir, names);
        cfg.assets = Some(assets);
        let server = LanServer::start(cfg, Arc::new(forward.clone()))
            .await
            .map_err(|e| e.to_string())?;
        let out = Started {
            port: server.addr().port(),
            fingerprint: server.fingerprint().to_string(),
            addresses: addrs.iter().map(|a| a.to_string()).collect(),
        };
        *slot = Some(Running { server, forward });
        Ok(out)
    }

    #[tauri::command]
    pub async fn lan_stop(state: State<'_, LanState>) -> Result<(), String> {
        if let Some(r) = state.running.lock().await.take() {
            r.server.stop().await;
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn lan_reply(
        state: State<'_, LanState>,
        id: u64,
        status: u16,
        body: String,
    ) -> Result<bool, String> {
        match &*state.running.lock().await {
            Some(r) => Ok(r.forward.reply(id, ForwardResponse { status, body })),
            None => Ok(false),
        }
    }
}

#[cfg(feature = "lan")]
pub use real::*;

#[cfg(not(feature = "lan"))]
mod real {
    use serde::Deserialize;

    #[derive(Default)]
    pub struct LanState;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct StartArgs {
        #[allow(dead_code)]
        pub port: u16,
    }

    const OFF: &str = "not_built: this build of GST Desk does not include tablet access";

    #[tauri::command]
    pub async fn lan_start(_args: StartArgs) -> Result<(), String> {
        Err(OFF.into())
    }

    #[tauri::command]
    pub async fn lan_stop() -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn lan_reply(_id: u64, _status: u16, _body: String) -> Result<bool, String> {
        Ok(false)
    }
}

#[cfg(not(feature = "lan"))]
pub use real::*;
