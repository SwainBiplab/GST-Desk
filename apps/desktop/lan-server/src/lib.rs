//! The desktop's LAN server. It does only what the app cannot do for itself: terminate TLS with a pinned
//! self-signed certificate, serve the built web app, advertise `gstdesk.local`, and hand every `/pair`
//! and `/rpc` request to the app and send back what the app answers. Who may do what is decided by the
//! app (`@gst/lan`), never here.
//!
//! It is only started when the person turns LAN access on, and stopped when they turn it off.

mod cert;
mod channel;
mod serve;

use std::{future::Future, net::SocketAddr, path::PathBuf, pin::Pin, sync::Arc, time::Duration};

use axum_server::{tls_rustls::RustlsConfig, Handle};

pub use cert::{fingerprint_of, Identity};
pub use channel::ChannelForward;

#[derive(Debug, thiserror::Error)]
pub enum LanError {
    #[error("could not make or read the certificate: {0}")]
    Cert(String),
    #[error("could not start the server: {0}")]
    Start(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Ping,
    Pair,
    Rpc,
}

#[derive(Debug, Clone)]
pub struct ForwardRequest {
    pub route: Route,
    pub ip: String,
    pub token: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct ForwardResponse {
    pub status: u16,
    pub body: String,
}

/// What the app does with a request. The desktop implements it by sending the request to the window and
/// waiting for the answer.
pub trait Forward: Send + Sync + 'static {
    fn call(&self, req: ForwardRequest) -> Pin<Box<dyn Future<Output = ForwardResponse> + Send>>;
}

/// A file of the web app, found by name.
#[derive(Debug, Clone)]
pub struct Asset {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// Finds a file of the web app by its path (`assets/app.js`). The installed app keeps its web files inside
/// the program, not in a folder, so it supplies this instead of a folder.
pub type AssetFn = Arc<dyn Fn(&str) -> Option<Asset> + Send + Sync>;

#[derive(Clone)]
pub struct LanConfig {
    /// Where to listen. Use `0.0.0.0:<port>` for the whole network, `127.0.0.1:0` in tests.
    pub bind: SocketAddr,
    /// The built web app.
    pub static_dir: PathBuf,
    /// Where the certificate and key are kept.
    pub cert_dir: PathBuf,
    /// Host names and addresses the certificate must be valid for.
    pub names: Vec<String>,
    /// Advertise `gstdesk.local` on the network. Failure is logged, never fatal.
    pub advertise: bool,
    /// Largest request body accepted, in bytes.
    pub max_body: usize,
    /// How long to wait for the app to answer.
    pub forward_timeout: Duration,
    /// When set, files come from here and `static_dir` is not read.
    pub assets: Option<AssetFn>,
}

impl LanConfig {
    pub fn new(
        bind: SocketAddr,
        static_dir: PathBuf,
        cert_dir: PathBuf,
        names: Vec<String>,
    ) -> Self {
        Self {
            bind,
            static_dir,
            cert_dir,
            names,
            advertise: true,
            max_body: 1_000_000,
            forward_timeout: Duration::from_secs(30),
            assets: None,
        }
    }
}

pub struct LanServer {
    addr: SocketAddr,
    fingerprint: String,
    cert_pem: String,
    handle: Handle,
    mdns: Option<mdns_sd::ServiceDaemon>,
    task: tokio::task::JoinHandle<()>,
}

/// Choose the crypto provider TLS uses, once. Two are compiled in, so the library will not pick for itself.
fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

impl LanServer {
    pub async fn start(cfg: LanConfig, forward: Arc<dyn Forward>) -> Result<LanServer, LanError> {
        ensure_crypto_provider();
        let id = cert::load_or_create(&cfg.cert_dir, &cfg.names)?;
        let tls = RustlsConfig::from_pem(
            id.cert_pem.clone().into_bytes(),
            id.key_pem.clone().into_bytes(),
        )
        .await
        .map_err(|e| LanError::Cert(e.to_string()))?;
        let listener =
            std::net::TcpListener::bind(cfg.bind).map_err(|e| LanError::Start(e.to_string()))?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        let handle = Handle::new();
        let app = serve::router(serve::State::new(&cfg, forward));
        let h = handle.clone();
        let task = tokio::spawn(async move {
            let server = axum_server::from_tcp_rustls(listener, tls)
                .handle(h)
                .serve(app.into_make_service_with_connect_info::<SocketAddr>());
            if let Err(e) = server.await {
                tracing::warn!("LAN server stopped: {e}");
            }
        });
        // wait until it is listening, so a caller can connect as soon as `start` returns
        handle.listening().await;
        let mdns = if cfg.advertise {
            advertise(addr.port())
        } else {
            None
        };
        Ok(LanServer {
            addr,
            fingerprint: id.fingerprint,
            cert_pem: id.cert_pem,
            handle,
            mdns,
            task,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// SHA-256 of the certificate, `AB:CD:...`, for the pairing QR.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn cert_pem(&self) -> &str {
        &self.cert_pem
    }

    /// Stop listening now and drop open connections.
    pub async fn stop(self) {
        if let Some(m) = &self.mdns {
            let _ = m.shutdown();
        }
        self.handle.shutdown();
        let _ = self.task.await;
    }
}

fn advertise(port: u16) -> Option<mdns_sd::ServiceDaemon> {
    let daemon = match mdns_sd::ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("could not advertise on the network: {e}");
            return None;
        }
    };
    let info = mdns_sd::ServiceInfo::new(
        "_https._tcp.local.",
        "GST Desk",
        "gstdesk.local.",
        "",
        port,
        None::<std::collections::HashMap<String, String>>,
    )
    .ok()?
    .enable_addr_auto();
    if let Err(e) = daemon.register(info) {
        tracing::warn!("could not advertise on the network: {e}");
        return None;
    }
    Some(daemon)
}

/// The addresses of this computer on its networks, for the certificate and for showing the person where to go.
pub fn lan_addresses() -> Vec<std::net::IpAddr> {
    if_addrs::get_if_addrs()
        .map(|v| {
            v.into_iter()
                .filter(|i| !i.is_loopback())
                .map(|i| i.ip())
                .filter(|ip| ip.is_ipv4())
                .collect()
        })
        .unwrap_or_default()
}
