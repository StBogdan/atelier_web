//! Atelier Cloud front door — the `serve/` box of the design (`atelier_web_design.md` 2.2, 2.3).
//!
//! OPFS is keyed by **origin**, so the editor and the cloud app only share one cloudspace if one
//! process serves both. This is that process:
//!
//! ```text
//! http://127.0.0.1:3000/         → the editor      (proxied to PHOTOCRAFT_UPSTREAM)
//! http://127.0.0.1:3000/cloud/   → Atelier Cloud   (static files from atelier_web/web/build)
//! ```
//!
//! Opening the editor's own port directly gives a *second* origin and a *second, empty* OPFS, which
//! fails silently. Always use this one (2.3, "Invariant: always open the front port").

use std::{env, net::SocketAddr, path::PathBuf};

use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{any, get},
    Router,
};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

/// Requests are proxied whole; the editor's wasm is ~26 MB, so this is generous but bounded.
const MAX_BODY: usize = 512 << 20;

#[derive(Clone)]
struct App {
    /// Where the editor lives, without a trailing slash, e.g. `http://127.0.0.1:8080`.
    upstream: String,
    http: reqwest::Client,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = env::var("ATELIER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);
    let upstream = env::var("PHOTOCRAFT_UPSTREAM").unwrap_or_else(|_| "http://127.0.0.1:8080".to_owned());
    let upstream = upstream.trim_end_matches('/').to_owned();
    let web_dir = env::var("ATELIER_WEB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/build"));

    let shell = web_dir.join("index.html");
    if !shell.is_file() {
        eprintln!("warning: {} has no index.html — build the cloud app: cd ../web && npm install && npm run build", web_dir.display());
    }

    let app = App { upstream: upstream.clone(), http: reqwest::Client::new() };

    let router = Router::new()
        .route("/api/health", get(health))
        // `/cloud` without the trailing slash would otherwise 404: point it at the directory.
        .route("/cloud", get(|| async { axum::response::Redirect::permanent("/cloud/") }))
        // Atelier Cloud is a static SPA (design 6, 14: SSR is off). One `index.html` serves every
        // route, so a path that is not a file falls back to it, with its own `200` status — that
        // is `fallback`, not `not_found_service`, which would keep the 404.
        .nest_service("/cloud/", ServeDir::new(&web_dir).append_index_html_on_directories(true).fallback(ServeFile::new(&shell)))
        // Everything else is the editor.
        .fallback(any(editor))
        .with_state(app);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        format!("cannot bind {addr}: {e}\n(another process on this port? set ATELIER_PORT to change it)")
    })?;

    println!("Atelier Cloud front door  →  http://127.0.0.1:{port}/");
    println!("    /cloud/   Atelier Cloud (static from {})", web_dir.display());
    println!("    /         the editor (proxy → {upstream})");
    println!("\nOpen http://127.0.0.1:{port}/cloud/ first, so both apps share one OPFS.");

    axum::serve(listener, router).await?;
    Ok(())
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "service": "atelier-web", "status": "ok", "hello": "world" }))
}

/// The editor, proxied so that it shares this origin — and therefore the OPFS — with the cloud app.
async fn editor(State(app): State<App>, req: Request) -> Response {
    let target = req.uri().path_and_query().map_or_else(|| "/".to_owned(), |pq| pq.as_str().to_owned());

    let response = app
        .http
        .request(req.method().clone(), format!("{}{target}", app.upstream))
        .headers(forward_request_headers(req.headers()))
        .body(to_bytes(req.into_body(), MAX_BODY).await.unwrap_or_default())
        .send()
        .await;

    match response {
        Ok(upstream) => {
            let status = upstream.status();
            let headers = forward_response_headers(upstream.headers());
            let body = upstream.bytes().await.unwrap_or_default();
            (status, headers, body).into_response()
        }
        Err(e) => editor_unreachable(&app.upstream, &target, &e.to_string()),
    }
}

/// Hop-by-hop headers must not be forwarded (RFC 9110 7.6.1), and `Host` must be re-derived from
/// the upstream URL rather than passed through. Everything else — including `Accept-Encoding` and
/// `Content-Encoding`, which the client and the upstream negotiate end to end — is forwarded, so the
/// editor's gzip and `application/wasm` handling keeps working unchanged.
fn forward_request_headers(headers: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in headers {
        if is_hop_by_hop(name) || name == header::HOST {
            continue;
        }
        out.append(name, value.clone());
    }
    out
}

fn forward_response_headers(headers: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in headers {
        if is_hop_by_hop(name) {
            continue;
        }
        out.append(name, value.clone());
    }
    out
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization" | "te" | "trailer" | "transfer-encoding" | "upgrade"
    )
}

/// A helpful page instead of a bare 502 when the editor is not running — the most common state
/// during development, so it should say how to fix it.
fn editor_unreachable(upstream: &str, target: &str, error: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Editor not reachable</title>\
         <style>body{{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:44rem;padding:0 1rem}}\
         code{{background:#f2f2f2;padding:.1em .35em;border-radius:3px}}h1{{font-size:1.3rem}}\
         pre{{background:#f7f7f7;padding:.6rem;overflow:auto;font-size:12px}}</style>\
         <h1>The editor isn't reachable at <code>{upstream}</code></h1>\
         <p>Atelier Cloud is running, but <code>{target}</code> belongs to the editor, which this server proxies.</p>\
         <p>Start it with <code>./run.sh</code> (which starts the container for you), or by hand:</p>\
         <ul><li><code>docker start photocraft-web</code> — the container on :8080</li>\
         <li><code>trunk serve</code> in <code>photocraft/apps/photocraft-web</code>, then \
         <code>PHOTOCRAFT_UPSTREAM=http://127.0.0.1:8765 ./run.sh</code></li></ul>\
         <p><code>/cloud/</code> works regardless.</p>\
         <details><summary>Proxy error</summary><pre>{error}</pre></details>"
    );
    (StatusCode::SERVICE_UNAVAILABLE, Html(body)).into_response()
}
