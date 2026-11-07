//! The routes: `/ping`, `/pair` and `/rpc` go to the app; anything else is a file of the built web app.

use std::{
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, State as AxState},
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};

use crate::{AssetFn, Forward, ForwardRequest, ForwardResponse, LanConfig, Route};

#[derive(Clone)]
pub struct State {
    forward: Arc<dyn Forward>,
    static_dir: PathBuf,
    assets: Option<AssetFn>,
    timeout: Duration,
    max_body: usize,
}

impl State {
    pub fn new(cfg: &LanConfig, forward: Arc<dyn Forward>) -> Self {
        Self {
            forward,
            static_dir: cfg.static_dir.clone(),
            assets: cfg.assets.clone(),
            timeout: cfg.forward_timeout,
            max_body: cfg.max_body,
        }
    }
}

pub fn router(state: State) -> Router {
    let limit = state.max_body;
    Router::new()
        .route("/ping", get(ping))
        .route("/pair", post(pair))
        .route("/rpc", post(rpc))
        .fallback(get(file))
        .layer(DefaultBodyLimit::max(limit))
        .with_state(state)
}

const JSON: &str = "application/json; charset=utf-8";

fn json(status: u16, body: String) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        [
            (header::CONTENT_TYPE, JSON),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response()
}

fn error(status: u16, code: &str, message: &str) -> Response {
    json(
        status,
        format!(r#"{{"ok":false,"error":{{"code":"{code}","message":"{message}"}}}}"#),
    )
}

async fn hand_over(state: &State, req: ForwardRequest) -> Response {
    match tokio::time::timeout(state.timeout, state.forward.call(req)).await {
        Ok(ForwardResponse { status, body }) => json(status, body),
        Err(_) => error(504, "timeout", "The computer did not answer in time."),
    }
}

async fn ping(AxState(s): AxState<State>, ConnectInfo(peer): ConnectInfo<SocketAddr>) -> Response {
    hand_over(
        &s,
        ForwardRequest {
            route: Route::Ping,
            ip: peer.ip().to_string(),
            token: None,
            body: String::new(),
        },
    )
    .await
}

async fn pair(
    AxState(s): AxState<State>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Response {
    let Ok(body) = String::from_utf8(body.to_vec()) else {
        return error(400, "bad_request", "The request is not text.");
    };
    hand_over(
        &s,
        ForwardRequest {
            route: Route::Pair,
            ip: peer.ip().to_string(),
            token: None,
            body,
        },
    )
    .await
}

async fn rpc(
    AxState(s): AxState<State>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(body) = String::from_utf8(body.to_vec()) else {
        return error(400, "bad_request", "The request is not text.");
    };
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    hand_over(
        &s,
        ForwardRequest {
            route: Route::Rpc,
            ip: peer.ip().to_string(),
            token,
            body,
        },
    )
    .await
}

/// A path under the web app's folder, or None if it tries to leave it.
pub fn safe_join(root: &Path, uri_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(uri_path)?;
    let rel = decoded.trim_start_matches('/');
    if rel.contains('\\') || rel.contains('\0') {
        return None;
    }
    let mut out = root.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// A file from the supplied lookup: the page for a route of the app, a 404 for a file that is not there.
fn from_assets(find: &AssetFn, uri_path: &str) -> Response {
    let key = uri_path.trim_start_matches('/');
    if key.contains("..") || key.contains('\\') || key.contains('\0') {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    let key = if key.is_empty() { "index.html" } else { key };
    let asset = find(key).or_else(|| {
        if Path::new(key).extension().is_none() {
            find("index.html")
        } else {
            None
        }
    });
    match asset {
        Some(a) => {
            let page =
                key == "index.html" || key == "sw.js" || Path::new(key).extension().is_none();
            let cache = if page {
                "no-cache"
            } else {
                "public, max-age=31536000, immutable"
            };
            let mime = header::HeaderValue::from_str(&a.mime)
                .unwrap_or(header::HeaderValue::from_static("application/octet-stream"));
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, mime),
                    (
                        header::CACHE_CONTROL,
                        header::HeaderValue::from_static(cache),
                    ),
                    (
                        header::X_CONTENT_TYPE_OPTIONS,
                        header::HeaderValue::from_static("nosniff"),
                    ),
                ],
                a.bytes,
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn file(AxState(s): AxState<State>, uri: Uri) -> Response {
    if let Some(find) = &s.assets {
        return from_assets(find, uri.path());
    }
    let Some(mut path) = safe_join(&s.static_dir, uri.path()) else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    if path.is_dir() {
        path.push("index.html");
    }
    let has_extension = path.extension().is_some();
    let target = if path.is_file() {
        path
    } else if !has_extension {
        // a route of the app (/shop/parties): the page loads and the app shows the route
        s.static_dir.join("index.html")
    } else {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    match tokio::fs::read(&target).await {
        Ok(bytes) => {
            let is_page = target.file_name().and_then(|n| n.to_str()) == Some("index.html")
                || target.file_name().and_then(|n| n.to_str()) == Some("sw.js");
            let cache = if is_page {
                "no-cache"
            } else {
                "public, max-age=31536000, immutable"
            };
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, content_type(&target)),
                    (header::CACHE_CONTROL, cache),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                    (header::REFERRER_POLICY, "no-referrer"),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}
