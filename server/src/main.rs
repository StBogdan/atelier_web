//! Atelier web — the one-origin server of the design
//! ([The One-Origin Development Setup](../../../docs/atelier_web_design.md)).
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
//! fails silently. Always use this one (design, [The One-Origin Development Setup](../../../docs/atelier_web_design.md),
//! "Invariant: always open the front port").

use std::{env, net::IpAddr, net::SocketAddr, path::PathBuf};

use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{any, get},
    Router,
};
use serde_json::json;
use tower::ServiceBuilder;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

mod profile;

use profile::Deployment;

/// Requests are proxied whole; the editor's wasm is ~26 MB, so this is generous but bounded.
const MAX_BODY: usize = 512 << 20;

#[derive(Clone)]
struct App {
    /// Where the editor lives, without a trailing slash, e.g. `http://127.0.0.1:8080`.
    upstream: String,
    http: reqwest::Client,
    /// Which edition this is, and the two answers that follow from it.
    deployment: Deployment,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = env::var("ATELIER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);
    // Loopback by default, which is right for the one-origin development setup and for a deployment
    // behind a reverse proxy. A container has no loopback to share with its host, so it sets this to
    // `0.0.0.0` (see the Dockerfile).
    let bind: IpAddr = env::var("ATELIER_BIND").ok().and_then(|b| b.parse().ok()).unwrap_or(IpAddr::from([127, 0, 0, 1]));
    let upstream = env::var("PHOTOCRAFT_UPSTREAM").unwrap_or_else(|_| "http://127.0.0.1:8080".to_owned());
    let upstream = upstream.trim_end_matches('/').to_owned();
    let web_dir = env::var("ATELIER_WEB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/build"));

    // The launcher, help and settings are prerendered files; this is the fallback the browser gets
    // for a route whose id is not known at build time, which is every workspace.
    let shell = web_dir.join("200.html");
    if !shell.is_file() {
        eprintln!("warning: {} has no 200.html — build the cloud app: cd ../web && npm install && npm run build", web_dir.display());
    }

    let deployment = deployment_or_exit();

    let app = App {
        upstream: upstream.clone(),
        http: reqwest::Client::new(),
        deployment: deployment.clone(),
    };

    let router = Router::new()
        .route("/api/health", get(health))
        // What this deployment can do, which is the whole of how the cloud app tells the two
        // editions apart. See `profile.rs`.
        .route("/api/capabilities", get(capabilities))
        // Crawlers ask the origin, and the editor has no answer: it is an app shell with nothing to
        // index. Both files name the request's own host, so a second deployment advertises itself.
        .route("/robots.txt", get(robots))
        .route("/sitemap.xml", get(sitemap))
        // `/cloud` without the trailing slash would otherwise 404: point it at the directory.
        .route("/cloud", get(|| async { axum::response::Redirect::permanent("/cloud/") }))
        // The prerendered pages are written as `help.html` and `settings.html`, which the directory
        // service does not look for; the slash form redirects so there is one URL per page.
        .route("/cloud/help/", get(|| async { axum::response::Redirect::permanent("/cloud/help") }))
        .route("/cloud/settings/", get(|| async { axum::response::Redirect::permanent("/cloud/settings") }))
        .route_service("/cloud/help", ServeFile::new(web_dir.join("help.html")))
        .route_service("/cloud/settings", ServeFile::new(web_dir.join("settings.html")))
        // The build's file names carry a content hash, so a year is safe for them. Everything else
        // revalidates, which is what makes a deploy visible on the next request rather than when a
        // browser decides its copy is old.
        .nest_service(
            "/cloud/_app/",
            ServiceBuilder::new()
                .layer(SetResponseHeaderLayer::overriding(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                ))
                .service(ServeDir::new(web_dir.join("_app"))),
        )
        // The launcher, help and settings are prerendered (design, The Landing Page and Launcher), so
        // they are files like any other, and a path that is not a file is a 404. That is what keeps
        // `/cloud/<anything>` from answering 200 with the app shell, which is a soft 404 for every
        // URL someone invents.
        .nest_service("/cloud/", ServeDir::new(&web_dir).append_index_html_on_directories(true))
        // A workspace id is not known at build time, so the client renders that route: only this
        // prefix falls back to the shell, and only this prefix loses its 404.
        .nest_service("/cloud/workspace/", ServeDir::new(&web_dir).fallback(ServeFile::new(&shell)))
        // Everything else is the editor.
        .fallback(any(editor))
        // `if_not_present` leaves the editor's own cache headers and the hashed assets above alone.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .with_state(app);

    let addr = SocketAddr::from((bind, port));
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        format!("cannot bind {addr}: {e}\n(another process on this port? set ATELIER_PORT to change it)")
    })?;

    print_banner(addr, &web_dir, &upstream);

    axum::serve(listener, router).await?;
    Ok(())
}

/// A deployment that cannot be configured is not a deployment. Say what is wrong and stop, rather
/// than serving a half-configured edition. `main` returns a `Box<dyn Error>`, which the runtime
/// prints with `Debug`, so the message is printed here where it can be the one the operator wrote
/// the variable for.
fn deployment_or_exit() -> Deployment {
    match Deployment::from_env() {
        Ok(deployment) => deployment,
        Err(error) => {
            eprintln!("atelier-web: {error}");
            eprintln!("    ATELIER_PROFILE is `standalone` (the default) or `hosted`.");
            eprintln!("    A hosted deployment also needs ATELIER_CENTRAL_URL.");
            std::process::exit(2);
        }
    }
}

fn print_banner(addr: SocketAddr, web_dir: &std::path::Path, upstream: &str) {
    println!("Atelier web  →  http://{addr}/");
    println!("    /cloud/   Atelier Cloud (static from {})", web_dir.display());
    println!("    /         the editor (proxy → {upstream})");
    println!("\nOpen http://{addr}/cloud/ first, so both apps share one OPFS.");
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "service": "atelier-web", "status": "ok", "hello": "world" }))
}

/// What the cloud app reads at boot, so it can hide what this deployment has no one to do.
async fn capabilities(State(app): State<App>) -> Json<profile::Capabilities> {
    Json(app.deployment.capabilities())
}

/// A workspace is someone's own, so it is the one path crawlers are asked to leave alone.
async fn robots(headers: HeaderMap) -> impl IntoResponse {
    let origin = site(&headers);
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        format!("User-agent: *\nAllow: /\nDisallow: /cloud/workspace/\n\nSitemap: {origin}/sitemap.xml\n"),
    )
}

/// The two public pages. Settings is left out because it reports this browser's storage, which is
/// nobody else's result to find.
async fn sitemap(headers: HeaderMap) -> impl IntoResponse {
    let origin = site(&headers);
    let urls: String = ["/cloud/", "/cloud/help"]
        .iter()
        .map(|path| format!("  <url><loc>{origin}{path}</loc></url>\n"))
        .collect();
    (
        [(header::CONTENT_TYPE, "application/xml; charset=utf-8")],
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{urls}</urlset>\n"
        ),
    )
}

/// The origin the request arrived on. nginx passes the public name in `Host`, and the characters
/// kept are the ones a hostname and an optional port need, so a header cannot put markup in either
/// file.
fn site(headers: &HeaderMap) -> String {
    let host: String = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        .collect();
    if host.is_empty() {
        "https://localhost".to_owned()
    } else {
        format!("https://{host}")
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_header_cannot_put_markup_in_the_sitemap() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("example.com</loc><script>"));
        assert_eq!(site(&headers), "https://example.comlocscript");
    }

    #[test]
    fn a_request_without_a_host_names_the_local_origin() {
        assert_eq!(site(&HeaderMap::new()), "https://localhost");
    }
}
