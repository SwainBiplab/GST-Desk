use std::{
    future::Future,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use gst_lan_server::{Forward, ForwardRequest, ForwardResponse, LanConfig, LanServer, Route};

/// Answers like the app would, and remembers what it was asked.
struct Mock {
    seen: Mutex<Vec<ForwardRequest>>,
    delay: Duration,
}

impl Forward for Mock {
    fn call(&self, req: ForwardRequest) -> Pin<Box<dyn Future<Output = ForwardResponse> + Send>> {
        self.seen.lock().unwrap().push(req.clone());
        let delay = self.delay;
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            match req.route {
                Route::Ping => ForwardResponse {
                    status: 200,
                    body: r#"{"ok":true}"#.into(),
                },
                Route::Pair => ForwardResponse {
                    status: 200,
                    body: format!(r#"{{"ok":true,"echo":{}}}"#, req.body),
                },
                Route::Rpc => match req.token.as_deref() {
                    Some("good") => ForwardResponse {
                        status: 200,
                        body: format!(r#"{{"ok":true,"result":{}}}"#, req.body),
                    },
                    _ => ForwardResponse {
                        status: 401,
                        body: r#"{"ok":false,"error":{"code":"bad_token","message":"no"}}"#.into(),
                    },
                },
            }
        })
    }
}

struct Rig {
    server: LanServer,
    mock: Arc<Mock>,
    web: tempfile::TempDir,
    certs: tempfile::TempDir,
    client: reqwest::Client,
}

impl Rig {
    fn url(&self, path: &str) -> String {
        format!("https://localhost:{}{}", self.server.addr().port(), path)
    }
}

fn client_trusting(cert_pem: &str, addr: SocketAddr) -> reqwest::Client {
    reqwest::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(cert_pem.as_bytes()).unwrap())
        .resolve("localhost", addr)
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}

async fn rig(delay: Duration, forward_timeout: Duration, max_body: usize) -> Rig {
    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "<html>app</html>").unwrap();
    std::fs::create_dir_all(web.path().join("assets")).unwrap();
    std::fs::write(web.path().join("assets/app.js"), "console.log(1)").unwrap();
    std::fs::write(web.path().join("secret.txt"), "not served").unwrap();
    let certs = tempfile::tempdir().unwrap();
    // the web folder is a subfolder, so a file beside it is out of reach
    let root = web.path().join("assets").parent().unwrap().to_path_buf();
    let _ = root;
    let mock = Arc::new(Mock {
        seen: Mutex::new(vec![]),
        delay,
    });
    let mut cfg = LanConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        web.path().to_path_buf(),
        certs.path().to_path_buf(),
        vec![
            "localhost".into(),
            "127.0.0.1".into(),
            "gstdesk.local".into(),
        ],
    );
    cfg.advertise = false;
    cfg.forward_timeout = forward_timeout;
    cfg.max_body = max_body;
    let server = LanServer::start(cfg, mock.clone()).await.unwrap();
    let client = client_trusting(server.cert_pem(), server.addr());
    Rig {
        server,
        mock,
        web,
        certs,
        client,
    }
}

async fn default_rig() -> Rig {
    rig(Duration::ZERO, Duration::from_secs(5), 1_000_000).await
}

#[tokio::test]
async fn serves_the_web_app_over_tls_with_the_pinned_certificate() {
    let r = default_rig().await;
    let res = r.client.get(r.url("/")).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "text/html; charset=utf-8");
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert_eq!(res.text().await.unwrap(), "<html>app</html>");

    let js = r.client.get(r.url("/assets/app.js")).send().await.unwrap();
    assert_eq!(
        js.headers()["content-type"],
        "text/javascript; charset=utf-8"
    );
    assert!(js.headers()["cache-control"]
        .to_str()
        .unwrap()
        .contains("immutable"));

    // a route of the app loads the page; a missing file with an extension is not found
    assert_eq!(
        r.client
            .get(r.url("/shop/parties"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "<html>app</html>"
    );
    assert_eq!(
        r.client
            .get(r.url("/assets/missing.js"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    r.server.stop().await;
}

#[tokio::test]
async fn refuses_a_client_that_does_not_trust_the_certificate() {
    let r = default_rig().await;
    let untrusting = reqwest::Client::builder()
        .resolve("localhost", r.server.addr())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert!(untrusting.get(r.url("/ping")).send().await.is_err());
    // and a plain-HTTP request to the same port does not get an answer
    let plain = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let res = plain
        .get(format!("http://127.0.0.1:{}/ping", r.server.addr().port()))
        .send()
        .await;
    assert!(res.map(|x| !x.status().is_success()).unwrap_or(true));
    r.server.stop().await;
}

#[tokio::test]
async fn will_not_serve_a_file_outside_the_web_folder() {
    let outer = tempfile::tempdir().unwrap();
    std::fs::write(outer.path().join("private.txt"), "private").unwrap();
    std::fs::create_dir(outer.path().join("web")).unwrap();
    std::fs::write(outer.path().join("web/index.html"), "ok").unwrap();
    let certs = tempfile::tempdir().unwrap();
    let mock = Arc::new(Mock {
        seen: Mutex::new(vec![]),
        delay: Duration::ZERO,
    });
    let mut cfg = LanConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        outer.path().join("web"),
        certs.path().to_path_buf(),
        vec!["localhost".into()],
    );
    cfg.advertise = false;
    let server = LanServer::start(cfg, mock).await.unwrap();
    let client = client_trusting(server.cert_pem(), server.addr());
    let base = format!("https://localhost:{}", server.addr().port());
    for p in [
        "/../private.txt",
        "/%2e%2e/private.txt",
        "/..%2fprivate.txt",
        "/assets/../../private.txt",
        "/%2E%2E%2Fprivate.txt",
        "/..\\private.txt",
    ] {
        let res = client.get(format!("{base}{p}")).send().await.unwrap();
        let text = res.text().await.unwrap();
        assert!(
            !text.contains("private") || text == "ok",
            "{p} leaked: {text}"
        );
        assert_ne!(text, "private", "{p}");
    }
    server.stop().await;
}

#[tokio::test]
async fn hands_pair_and_rpc_to_the_app_with_the_token_and_the_callers_address() {
    let r = default_rig().await;
    let ping = r.client.get(r.url("/ping")).send().await.unwrap();
    assert_eq!(ping.text().await.unwrap(), r#"{"ok":true}"#);

    let pair = r
        .client
        .post(r.url("/pair"))
        .body(r#"{"code":"1"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(pair.status(), 200);
    assert_eq!(
        pair.headers()["content-type"],
        "application/json; charset=utf-8"
    );
    assert_eq!(
        pair.text().await.unwrap(),
        r#"{"ok":true,"echo":{"code":"1"}}"#
    );

    let ok = r
        .client
        .post(r.url("/rpc"))
        .header("Authorization", "Bearer good")
        .body(r#"{"method":"x"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
    assert_eq!(
        ok.text().await.unwrap(),
        r#"{"ok":true,"result":{"method":"x"}}"#
    );

    // the app's refusal passes through with its status, and a request with no token reaches it without one
    let no = r
        .client
        .post(r.url("/rpc"))
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(no.status(), 401);
    let bad = r
        .client
        .post(r.url("/rpc"))
        .header("Authorization", "Basic abc")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 401);

    let seen = r.mock.seen.lock().unwrap().clone();
    let rpc: Vec<_> = seen.iter().filter(|s| s.route == Route::Rpc).collect();
    assert_eq!(rpc[0].token.as_deref(), Some("good"));
    assert_eq!(rpc[0].ip, "127.0.0.1");
    assert_eq!(rpc[1].token, None);
    assert_eq!(rpc[2].token, None);
    drop(seen);
    r.server.stop().await;
}

#[tokio::test]
async fn refuses_a_body_over_the_limit_and_does_not_hand_it_over() {
    let r = rig(Duration::ZERO, Duration::from_secs(5), 100).await;
    let big = "x".repeat(500);
    let res = r
        .client
        .post(r.url("/rpc"))
        .header("Authorization", "Bearer good")
        .body(big)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 413);
    assert!(r.mock.seen.lock().unwrap().is_empty());
    r.server.stop().await;
}

#[tokio::test]
async fn answers_504_when_the_app_does_not_answer_in_time() {
    let r = rig(
        Duration::from_millis(800),
        Duration::from_millis(100),
        1_000_000,
    )
    .await;
    let res = r
        .client
        .post(r.url("/rpc"))
        .header("Authorization", "Bearer good")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 504);
    assert!(res.text().await.unwrap().contains(r#""code":"timeout""#));
    r.server.stop().await;
}

#[tokio::test]
async fn keeps_its_certificate_between_runs_and_makes_a_new_one_when_the_names_change() {
    let certs = tempfile::tempdir().unwrap();
    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "x").unwrap();
    let start = |names: Vec<&str>| {
        let mock = Arc::new(Mock {
            seen: Mutex::new(vec![]),
            delay: Duration::ZERO,
        });
        let mut cfg = LanConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            web.path().to_path_buf(),
            certs.path().to_path_buf(),
            names.into_iter().map(String::from).collect(),
        );
        cfg.advertise = false;
        LanServer::start(cfg, mock)
    };
    let a = start(vec!["localhost", "gstdesk.local"]).await.unwrap();
    let fa = a.fingerprint().to_string();
    assert!(fa.contains(':') && fa.len() == 95, "{fa}");
    a.stop().await;
    let b = start(vec!["gstdesk.local", "localhost"]).await.unwrap();
    assert_eq!(
        b.fingerprint(),
        fa,
        "the same names, in another order, keep the certificate"
    );
    b.stop().await;
    let c = start(vec!["localhost", "gstdesk.local", "192.168.1.42"])
        .await
        .unwrap();
    assert_ne!(c.fingerprint(), fa, "a new address needs a new certificate");
    c.stop().await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(certs.path().join("lan-key.pem"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "the private key is readable by this user only");
    }
}

#[tokio::test]
async fn stops_listening_when_stopped() {
    let r = default_rig().await;
    let addr = r.server.addr();
    let client = r.client.clone();
    let url = r.url("/ping");
    assert!(client.get(&url).send().await.is_ok());
    r.server.stop().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_err());
    let _ = (&r.web, &r.certs);
}

#[tokio::test]
async fn handles_many_clients_at_once() {
    let r = default_rig().await;
    let mut tasks = vec![];
    for i in 0..40 {
        let c = r.client.clone();
        let url = r.url("/rpc");
        tasks.push(tokio::spawn(async move {
            let res = c
                .post(url)
                .header("Authorization", "Bearer good")
                .body(format!(r#"{{"n":{i}}}"#))
                .send()
                .await
                .unwrap();
            (res.status().as_u16(), res.text().await.unwrap())
        }));
    }
    for (i, t) in tasks.into_iter().enumerate() {
        let (status, body) = t.await.unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, format!(r#"{{"ok":true,"result":{{"n":{i}}}}}"#));
    }
    r.server.stop().await;
}

#[tokio::test]
async fn the_window_hand_off_delivers_replies_and_forgets_requests_nobody_answers() {
    use gst_lan_server::ChannelForward;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u64, ForwardRequest)>();
    let fwd = ChannelForward::new(move |id, req| {
        let _ = tx.send((id, req.clone()));
    });

    // answered: the window gets a numbered request and replies with that number
    let f = fwd.clone();
    let call = tokio::spawn(async move {
        f.call(ForwardRequest {
            route: Route::Rpc,
            ip: "1.2.3.4".into(),
            token: Some("t".into()),
            body: "{}".into(),
        })
        .await
    });
    let (id, got) = rx.recv().await.unwrap();
    assert_eq!(got.token.as_deref(), Some("t"));
    assert_eq!(fwd.waiting(), 1);
    assert!(fwd.reply(
        id,
        ForwardResponse {
            status: 200,
            body: "done".into()
        }
    ));
    let out = call.await.unwrap();
    assert_eq!((out.status, out.body.as_str()), (200, "done"));
    assert_eq!(fwd.waiting(), 0);
    assert!(
        !fwd.reply(
            id,
            ForwardResponse {
                status: 200,
                body: "again".into()
            }
        ),
        "a reply works once"
    );

    // not answered: the wait is given up and the table is left empty
    let f = fwd.clone();
    let slow = tokio::time::timeout(Duration::from_millis(50), async move {
        f.call(ForwardRequest {
            route: Route::Ping,
            ip: "x".into(),
            token: None,
            body: String::new(),
        })
        .await
    })
    .await;
    assert!(slow.is_err());
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(fwd.waiting(), 0);
    assert!(!fwd.reply(
        999,
        ForwardResponse {
            status: 200,
            body: String::new()
        }
    ));
}

#[tokio::test]
async fn works_end_to_end_with_the_window_hand_off() {
    use gst_lan_server::ChannelForward;
    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "x").unwrap();
    let certs = tempfile::tempdir().unwrap();
    // the "window" answers every request on its own task
    let slot: Arc<Mutex<Option<Arc<ChannelForward>>>> = Arc::new(Mutex::new(None));
    let s2 = slot.clone();
    let fwd = ChannelForward::new(move |id, req| {
        let f = s2.lock().unwrap().clone().unwrap();
        let body = format!(r#"{{"ok":true,"route":"{:?}","n":{}}}"#, req.route, id);
        tokio::spawn(async move {
            f.reply(id, ForwardResponse { status: 200, body });
        });
    });
    *slot.lock().unwrap() = Some(fwd.clone());
    let mut cfg = LanConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        web.path().to_path_buf(),
        certs.path().to_path_buf(),
        vec!["localhost".into()],
    );
    cfg.advertise = false;
    let server = LanServer::start(cfg, Arc::new(fwd)).await.unwrap();
    let client = client_trusting(server.cert_pem(), server.addr());
    let res = client
        .post(format!("https://localhost:{}/rpc", server.addr().port()))
        .header("Authorization", "Bearer z")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.text().await.unwrap().contains(r#""route":"Rpc""#));
    server.stop().await;
}

#[tokio::test]
async fn serves_files_from_a_lookup_when_the_web_app_is_inside_the_program() {
    use gst_lan_server::{Asset, AssetFn};
    let find: AssetFn = Arc::new(|p: &str| match p {
        "index.html" => Some(Asset {
            bytes: b"<html>embedded</html>".to_vec(),
            mime: "text/html".into(),
        }),
        "assets/app.js" => Some(Asset {
            bytes: b"js".to_vec(),
            mime: "text/javascript".into(),
        }),
        _ => None,
    });
    let certs = tempfile::tempdir().unwrap();
    let mock = Arc::new(Mock {
        seen: Mutex::new(vec![]),
        delay: Duration::ZERO,
    });
    let mut cfg = LanConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        "/nonexistent".into(),
        certs.path().to_path_buf(),
        vec!["localhost".into()],
    );
    cfg.advertise = false;
    cfg.assets = Some(find);
    let server = LanServer::start(cfg, mock).await.unwrap();
    let c = client_trusting(server.cert_pem(), server.addr());
    let base = format!("https://localhost:{}", server.addr().port());
    assert_eq!(
        c.get(format!("{base}/"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "<html>embedded</html>"
    );
    assert_eq!(
        c.get(format!("{base}/assets/app.js"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "js"
    );
    assert_eq!(
        c.get(format!("{base}/shop/parties"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "<html>embedded</html>"
    );
    assert_eq!(
        c.get(format!("{base}/nothing.png"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    // the client folds `%2e%2e` away, so this arrives as `/secret`: a page route, never a file outside the app
    let body = c
        .get(format!("{base}/%2e%2e/secret"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "<html>embedded</html>");
    server.stop().await;
}
