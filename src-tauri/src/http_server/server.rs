use axum::{
    body::Body,
    extract::{ws::WebSocketUpgrade, Path as AxumPath, Query, State},
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use if_addrs::get_if_addrs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{Any, CorsLayer};

use super::auth;
use super::websocket::handle_ws_connection;
use super::EmitExt;
use super::WsBroadcaster;

/// Shared state for the Axum server.
#[derive(Clone)]
struct AppState {
    app: AppHandle,
    token: String,
    token_required: bool,
    localhost_only: bool,
    dist_path: std::path::PathBuf,
}

/// Server handle for shutdown coordination.
pub struct HttpServerHandle {
    pub shutdown_tx: tokio::sync::oneshot::Sender<()>,
    pub port: u16,
    pub token: String,
    pub url: String,
    pub bind_host: String,
    pub localhost_only: bool,
    pub token_required: bool,
}

/// Status response for the HTTP server.
#[derive(Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    pub url: Option<String>,
    pub token: Option<String>,
    pub port: Option<u16>,
    pub bind_host: Option<String>,
    pub localhost_only: Option<bool>,
}

#[derive(Deserialize)]
struct WsAuth {
    token: Option<String>,
    /// `reconnect` returns the smallest payload needed after a WebSocket drop.
    /// Full page loads omit this and receive the broader bootstrap payload.
    mode: Option<String>,
    /// Comma-separated worktreeId:sessionId pairs from the browser's current state.
    /// Used by /api/init to load the correct active sessions even when
    /// ui_state.json on disk is stale (debounced save hasn't flushed yet).
    active_sessions: Option<String>,
    /// Browser-provided selected project id. Overrides `ui_state.selected_project_id`
    /// when the disk copy is stale. Used to scope the init payload to only the
    /// worktrees/sessions the user is currently viewing.
    selected_project: Option<String>,
}

impl WsAuth {
    fn is_reconnect(&self) -> bool {
        self.mode.as_deref() == Some("reconnect")
    }
}

fn selected_project_id_for_init(
    selected_project: Option<&str>,
    ui_state: Option<&crate::UIState>,
) -> Option<String> {
    selected_project
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            ui_state
                .and_then(|u| u.active_project_id.clone())
                .filter(|s| !s.is_empty())
        })
}

#[derive(Serialize, Clone)]
pub struct BindHostOption {
    pub host: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WebBuildInfo {
    web_build_id: String,
    app_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    built_at: Option<String>,
}

impl Default for WebBuildInfo {
    fn default() -> Self {
        Self {
            web_build_id: env!("CARGO_PKG_VERSION").to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            git_sha: None,
            built_at: None,
        }
    }
}

async fn read_web_build_info(dist_path: &std::path::Path) -> WebBuildInfo {
    let path = dist_path.join("jean-build.json");
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => serde_json::from_str::<WebBuildInfo>(&contents).unwrap_or_else(|e| {
            log::warn!("Failed to parse {}: {e}", path.display());
            WebBuildInfo::default()
        }),
        Err(e) => {
            log::debug!("No web build info at {}: {e}", path.display());
            WebBuildInfo::default()
        }
    }
}

/// Resolve the dist directory path at runtime.
/// Checks multiple locations for development and production scenarios.
fn resolve_dist_path(app: &AppHandle) -> std::path::PathBuf {
    // Development: prefer local dist output first so `vite build --watch`
    // changes are served immediately instead of stale bundled resources.
    let dev_dist = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    if cfg!(debug_assertions) && dev_dist.exists() && dev_dist.join("index.html").exists() {
        log::info!("Serving frontend from dev dist: {}", dev_dist.display());
        return dev_dist;
    }

    // 1. Check if app has a resource dir with dist/ (bundled via resources config)
    if let Ok(resource_dir) = app.path().resource_dir() {
        log::info!("Resource dir: {}", resource_dir.display());

        let dist = resource_dir.join("dist");
        if dist.exists() && dist.join("index.html").exists() {
            log::info!("Serving frontend from resource dir: {}", dist.display());
            return dist;
        }

        // 1b. Check resource dir itself (flat resources on some platforms)
        if resource_dir.join("index.html").exists() {
            log::info!(
                "Serving frontend from resource dir (flat): {}",
                resource_dir.display()
            );
            return resource_dir;
        }
    }

    // 2. Fallback to local dist path (also used in release if needed)
    if dev_dist.exists() && dev_dist.join("index.html").exists() {
        log::info!("Serving frontend from dev dist: {}", dev_dist.display());
        return dev_dist;
    }

    // 3. Fallback: relative to executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let dist = parent.join("dist");
            if dist.exists() && dist.join("index.html").exists() {
                log::info!(
                    "Serving frontend from exe-relative dist: {}",
                    dist.display()
                );
                return dist;
            }
        }
    }

    // Last resort: return dev path even if it doesn't exist yet
    log::warn!(
        "No dist directory found with index.html, using dev path: {}",
        dev_dist.display()
    );
    dev_dist
}

/// Start the HTTP + WebSocket server.
pub async fn start_server(
    app: AppHandle,
    port: u16,
    token: String,
    bind_host: String,
    token_required: bool,
) -> Result<HttpServerHandle, String> {
    let bind_ip = parse_bind_ip(&bind_host)?;
    let localhost_only = bind_ip.is_loopback();

    // Resolve the dist directory at runtime for static file serving
    let dist_path = resolve_dist_path(&app);

    let state = AppState {
        app: app.clone(),
        token: token.clone(),
        token_required,
        localhost_only,
        dist_path: dist_path.clone(),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/auth", get(auth_handler))
        .route("/api/init", get(init_handler))
        .route("/api/version", get(version_handler))
        .route("/api/files/{*filepath}", get(file_handler))
        .route("/api/project-files/{*filepath}", get(project_file_handler))
        .fallback(get(static_handler))
        .layer(CompressionLayer::new().br(true).gzip(true))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::new(bind_ip, port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind to {bind_host}:{port}: {e}"))?;

    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {e}"))?;

    let url = format_http_url(&display_host_for_bind_ip(bind_ip), local_addr.port());

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let bind_host_for_log = bind_host.clone();

    // Spawn the server
    tokio::spawn(async move {
        log::info!(
            "HTTP server listening on {local_addr} (bind_host: {bind_host_for_log}, localhost_only: {localhost_only})"
        );
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
                log::info!("HTTP server shutting down");
            })
            .await
            .unwrap_or_else(|e| log::error!("HTTP server error: {e}"));
    });

    Ok(HttpServerHandle {
        shutdown_tx,
        port: local_addr.port(),
        token,
        url,
        bind_host,
        localhost_only,
        token_required,
    })
}

/// WebSocket upgrade handler with token auth.
async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsAuth>,
    State(state): State<AppState>,
) -> Response {
    // Validate token (skip if token not required)
    if state.token_required {
        let provided = params.token.as_deref().unwrap_or_default();
        if !auth::validate_token(provided, &state.token) {
            return (StatusCode::UNAUTHORIZED, "Invalid token").into_response();
        }
    }

    // Get broadcast receiver for this client
    let broadcaster = state.app.try_state::<WsBroadcaster>();
    let event_rx = match broadcaster {
        Some(b) => b.subscribe(),
        None => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Server not initialized").into_response();
        }
    };

    let app = state.app.clone();
    ws.on_upgrade(move |socket| handle_ws_connection(socket, app, event_rx))
}

/// Token validation endpoint. Returns 200 with { ok: true } on success,
/// or 401 with { ok: false, error: "..." } on failure.
async fn auth_handler(Query(params): Query<WsAuth>, State(state): State<AppState>) -> Response {
    let build_info = read_web_build_info(&state.dist_path).await;

    // If token not required, always return success
    if !state.token_required {
        return Json(serde_json::json!({
            "ok": true,
            "token_required": false,
            "webBuildId": build_info.web_build_id,
            "appVersion": build_info.app_version,
        }))
        .into_response();
    }

    let provided = params.token.unwrap_or_default();
    if auth::validate_token(&provided, &state.token) {
        Json(serde_json::json!({
            "ok": true,
            "webBuildId": build_info.web_build_id,
            "appVersion": build_info.app_version,
        }))
        .into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "ok": false, "error": "Invalid token" })),
        )
            .into_response()
    }
}

async fn version_handler(Query(params): Query<WsAuth>, State(state): State<AppState>) -> Response {
    if state.token_required {
        let provided = params.token.as_deref().unwrap_or_default();
        if !auth::validate_token(provided, &state.token) {
            return (StatusCode::UNAUTHORIZED, "Invalid token").into_response();
        }
    }

    Json(read_web_build_info(&state.dist_path).await).into_response()
}

/// Maximum number of chat messages loaded per active session at init.
/// Older messages are fetched on-demand via `load_older_session_messages`
/// when the user scrolls up in the chat window.
const INIT_MESSAGE_WINDOW: usize = 50;

/// Maximum number of buffered WebSocket events replayed per focused running
/// session at init. Plenty to reconstruct an in-flight turn; full stream
/// continues over the WebSocket connection.
const INIT_REPLAY_EVENT_CAP: usize = 200;

type WorktreesByProject = std::collections::HashMap<String, Vec<crate::projects::types::Worktree>>;
type SessionsByWorktree = std::collections::HashMap<String, crate::chat::types::WorktreeSessions>;

async fn load_selected_project_bootstrap(
    app: AppHandle,
    project_id: String,
) -> (WorktreesByProject, SessionsByWorktree) {
    let worktrees = crate::projects::list_worktrees(app.clone(), project_id.clone())
        .await
        .unwrap_or_default();

    let sessions_futures: Vec<_> = worktrees
        .iter()
        .map(|wt| {
            let app = app.clone();
            let worktree_id = wt.id.clone();
            let worktree_path = wt.path.clone();
            async move {
                let sessions = crate::chat::get_sessions(
                    app,
                    worktree_id.clone(),
                    worktree_path,
                    None,       // include_archived
                    Some(true), // include_message_counts
                )
                .await
                .unwrap_or_default();
                (worktree_id, sessions)
            }
        })
        .collect();

    let sessions_by_worktree = futures_util::future::join_all(sessions_futures)
        .await
        .into_iter()
        .collect();

    let mut worktrees_by_project = std::collections::HashMap::new();
    worktrees_by_project.insert(project_id, worktrees);
    (worktrees_by_project, sessions_by_worktree)
}

fn parse_active_sessions_param(value: Option<&str>) -> std::collections::HashMap<String, String> {
    value
        .unwrap_or("")
        .split(',')
        .filter_map(|pair| {
            let pair = pair.trim();
            let (wt, sess) = pair.split_once(':')?;
            if wt.is_empty() || sess.is_empty() {
                return None;
            }
            Some((wt.to_string(), sess.to_string()))
        })
        .collect()
}

async fn reconnect_init_response(params: WsAuth, state: AppState) -> Response {
    let mut response = serde_json::json!({});
    let build_info = read_web_build_info(&state.dist_path).await;
    response["webBuildId"] = Value::String(build_info.web_build_id);
    response["appVersion"] = Value::String(build_info.app_version);

    if let Ok(app_data_dir) = state.app.path().app_data_dir() {
        response["appDataDir"] = Value::String(app_data_dir.to_string_lossy().to_string());
    }

    let (projects_result, ui_state_result) = tokio::join!(
        crate::projects::list_projects(state.app.clone()),
        crate::load_ui_state(state.app.clone()),
    );

    let projects = match projects_result {
        Ok(projects) => projects,
        Err(e) => {
            log::error!("Failed to load projects for reconnect /api/init: {e}");
            vec![]
        }
    };
    let ui_state = match ui_state_result {
        Ok(ui_state) => Some(ui_state),
        Err(e) => {
            log::error!("Failed to load ui_state for reconnect /api/init: {e}");
            None
        }
    };

    if let Ok(val) = serde_json::to_value(&projects) {
        response["projects"] = val;
    }
    if let Some(ref ui) = ui_state {
        if let Ok(val) = serde_json::to_value(ui) {
            response["uiState"] = val;
        }
    }

    let selected_project_id =
        selected_project_id_for_init(params.selected_project.as_deref(), ui_state.as_ref());
    let selected_project = selected_project_id
        .as_deref()
        .and_then(|id| projects.iter().find(|p| p.id == id && !p.is_folder));
    if let Some(project) = selected_project {
        let (worktrees_by_project, sessions_by_worktree) =
            load_selected_project_bootstrap(state.app.clone(), project.id.clone()).await;
        if let Ok(val) = serde_json::to_value(&worktrees_by_project) {
            response["worktreesByProject"] = val;
        }
        if let Ok(val) = serde_json::to_value(&sessions_by_worktree) {
            response["sessionsByWorktree"] = val;
        }
    }

    let browser_active_sessions = parse_active_sessions_param(params.active_sessions.as_deref());

    if !browser_active_sessions.is_empty() {
        let session_futures: Vec<_> = browser_active_sessions
            .iter()
            .map(|(worktree_id, session_id)| {
                let app = state.app.clone();
                let wt_id = worktree_id.clone();
                let sess_id = session_id.clone();
                async move {
                    let worktree =
                        crate::projects::get_worktree(app.clone(), wt_id.clone()).await?;
                    let session = crate::chat::get_session(
                        app,
                        wt_id.clone(),
                        worktree.path,
                        sess_id.clone(),
                        Some(INIT_MESSAGE_WINDOW),
                    )
                    .await?;
                    Ok::<_, String>((sess_id, wt_id, session))
                }
            })
            .collect();

        let mut active_sessions = serde_json::Map::new();
        let mut active_session_worktree_ids = serde_json::Map::new();

        for result in futures_util::future::join_all(session_futures).await {
            match result {
                Ok((session_id, worktree_id, session)) => {
                    if let Ok(value) = serde_json::to_value(session) {
                        active_sessions.insert(session_id.clone(), value);
                        active_session_worktree_ids.insert(session_id, Value::String(worktree_id));
                    }
                }
                Err(e) => {
                    log::warn!("Failed to load reconnect active session: {e}");
                }
            }
        }

        if !active_sessions.is_empty() {
            response["activeSessions"] = Value::Object(active_sessions);
            response["activeSessionWorktreeIds"] = Value::Object(active_session_worktree_ids);
        }
    }

    let running_sessions = crate::chat::registry::get_running_sessions();
    response["runningSessions"] = serde_json::to_value(&running_sessions).unwrap_or_default();

    if !running_sessions.is_empty() && !browser_active_sessions.is_empty() {
        let focused: HashSet<&String> = browser_active_sessions
            .values()
            .filter(|session_id| running_sessions.contains(session_id))
            .collect();

        if !focused.is_empty() {
            let mut replay_events: Vec<Value> = state
                .app
                .try_state::<WsBroadcaster>()
                .map(|broadcaster| {
                    let mut events: Vec<Value> = focused
                        .iter()
                        .flat_map(|session_id| {
                            let buffered = broadcaster.replay_events(session_id, 0);
                            let start = buffered.len().saturating_sub(INIT_REPLAY_EVENT_CAP);
                            buffered[start..].to_vec()
                        })
                        .filter_map(|(_, json)| serde_json::from_str::<Value>(&json).ok())
                        .collect();
                    events.sort_by_key(|event| {
                        event
                            .get("seq")
                            .and_then(|seq| seq.as_u64())
                            .unwrap_or_default()
                    });
                    events
                })
                .unwrap_or_default();

            replay_events.dedup_by(|a, b| {
                a.get("seq").and_then(|seq| seq.as_u64())
                    == b.get("seq").and_then(|seq| seq.as_u64())
            });

            if !replay_events.is_empty() {
                response["replayEvents"] = Value::Array(replay_events);
            }
        }
    }

    Json(response).into_response()
}

/// Initial data endpoint. Returns only the data needed to render the view the
/// user lands on (project list + currently-selected project's worktrees +
/// windowed messages for the focused session). Additional data is lazy-loaded
/// by the frontend via TanStack Query hooks when the user navigates.
async fn init_handler(Query(params): Query<WsAuth>, State(state): State<AppState>) -> Response {
    // Validate token (skip if token not required)
    if state.token_required {
        let provided = params.token.as_deref().unwrap_or_default();
        if !auth::validate_token(provided, &state.token) {
            return (StatusCode::UNAUTHORIZED, "Invalid token").into_response();
        }
    }

    if params.is_reconnect() {
        return reconnect_init_response(params, state).await;
    }

    // Fetch base (always-included) data in parallel
    let (projects_result, preferences_result, ui_state_result) = tokio::join!(
        crate::projects::list_projects(state.app.clone()),
        crate::load_preferences(state.app.clone()),
        crate::load_ui_state(state.app.clone()),
    );

    let mut response = serde_json::json!({});
    let build_info = read_web_build_info(&state.dist_path).await;
    response["webBuildId"] = Value::String(build_info.web_build_id.clone());
    response["appVersion"] = Value::String(build_info.app_version.clone());

    let projects = match projects_result {
        Ok(projects) => projects,
        Err(e) => {
            log::error!("Failed to load projects for /api/init: {e}");
            vec![]
        }
    };

    let mut ui_state = match &ui_state_result {
        Ok(ui_state) => Some(ui_state.clone()),
        Err(_) => None,
    };

    // Resolve the "focused" project to scope the payload around.
    // Priority: browser override query param > ui_state.active_project_id.
    // Fall back to active_worktree_id's parent project if no active_project_id.
    let selected_project_id: Option<String> =
        selected_project_id_for_init(params.selected_project.as_deref(), ui_state.as_ref());

    // Validate the selected project exists and is a real project (not a folder).
    let selected_project = selected_project_id
        .as_deref()
        .and_then(|id| projects.iter().find(|p| p.id == id && !p.is_folder));

    // Fetch worktrees + sessions (counts only) ONLY for the selected project.
    // All other projects' worktrees/sessions are lazy-loaded by the frontend
    // when the user navigates.
    let (worktrees_by_project, sessions_by_worktree): (WorktreesByProject, SessionsByWorktree) =
        if let Some(project) = selected_project {
            load_selected_project_bootstrap(state.app.clone(), project.id.clone()).await
        } else {
            (
                std::collections::HashMap::new(),
                std::collections::HashMap::new(),
            )
        };

    // Only worktrees in the selected project are "known" for validation/cleanup.
    // Entries in ui_state.active_session_ids for worktrees outside this scope
    // are left untouched — we don't have the data to judge them.
    let is_active_session_valid = |worktree_id: &str, session_id: &str| {
        sessions_by_worktree
            .get(worktree_id)
            .map(|ws| {
                ws.sessions
                    .iter()
                    .any(|s| s.id == session_id && s.archived_at.is_none())
            })
            .unwrap_or(false)
    };
    let is_worktree_in_scope = |worktree_id: &str| sessions_by_worktree.contains_key(worktree_id);

    // Parse browser-provided active session IDs (worktreeId:sessionId pairs).
    // These override ui_state.json which may be stale due to debounced save.
    let browser_active_sessions = parse_active_sessions_param(params.active_sessions.as_deref());

    // Merge browser's active sessions into ui_state (browser is more recent
    // than disk when ui_state.json save is debounced). Only merge entries we
    // can validate (inside scope); unknown worktrees pass through untouched
    // since the frontend is the source of truth for them.
    if !browser_active_sessions.is_empty() {
        if let Some(ref mut ui) = ui_state {
            for (worktree_id, session_id) in &browser_active_sessions {
                if is_active_session_valid(worktree_id, session_id) {
                    log::debug!(
                        "Using browser active session {session_id} for worktree {worktree_id}"
                    );
                    ui.active_session_ids
                        .insert(worktree_id.clone(), session_id.clone());
                } else if !is_worktree_in_scope(worktree_id) {
                    // Out-of-scope worktree — trust browser.
                    ui.active_session_ids
                        .insert(worktree_id.clone(), session_id.clone());
                }
            }
        }
    }

    let mut cleaned_active_sessions: Vec<(String, Option<String>)> = Vec::new();

    // Clean up stale active_session_ids that reference deleted/archived sessions.
    // Only operates on worktrees inside the selected project's scope (where
    // we have authoritative session data). Out-of-scope entries are preserved.
    if let Some(ref mut ui) = ui_state {
        let stale_keys: Vec<String> = ui
            .active_session_ids
            .iter()
            .filter(|(worktree_id, session_id)| {
                is_worktree_in_scope(worktree_id)
                    && !is_active_session_valid(worktree_id, session_id)
            })
            .map(|(k, _)| k.clone())
            .collect();

        for worktree_id in stale_keys {
            let old_id = ui.active_session_ids.remove(&worktree_id);
            let fallback_session_id = sessions_by_worktree
                .get(&worktree_id)
                .and_then(|ws| ws.sessions.iter().find(|s| s.archived_at.is_none()))
                .map(|fallback| fallback.id.clone());

            if let Some(ref fallback_id) = fallback_session_id {
                log::info!(
                    "Replacing stale active session {} with {} for worktree {worktree_id}",
                    old_id.as_deref().unwrap_or("?"),
                    fallback_id
                );
                ui.active_session_ids
                    .insert(worktree_id.clone(), fallback_id.clone());
            } else {
                log::info!(
                    "Removed stale active session {} for worktree {worktree_id} (no fallback)",
                    old_id.as_deref().unwrap_or("?")
                );
            }

            cleaned_active_sessions.push((worktree_id, fallback_session_id));
        }
    }

    if !cleaned_active_sessions.is_empty() {
        match crate::load_ui_state(state.app.clone()).await {
            Ok(mut latest_ui_state) => {
                let mut persisted_cleanup = false;

                for (worktree_id, fallback_session_id) in &cleaned_active_sessions {
                    let should_update = latest_ui_state
                        .active_session_ids
                        .get(worktree_id)
                        .map(|session_id| !is_active_session_valid(worktree_id, session_id))
                        .unwrap_or(false);

                    if !should_update {
                        continue;
                    }

                    persisted_cleanup = true;

                    if let Some(fallback_id) = fallback_session_id {
                        latest_ui_state
                            .active_session_ids
                            .insert(worktree_id.clone(), fallback_id.clone());
                    } else {
                        latest_ui_state.active_session_ids.remove(worktree_id);
                    }
                }

                if persisted_cleanup {
                    if let Err(e) = crate::save_ui_state(state.app.clone(), latest_ui_state).await {
                        log::error!("Failed to persist cleaned ui_state for /api/init: {e}");
                    } else if let Err(e) = state.app.emit_all(
                        "cache:invalidate",
                        &serde_json::json!({ "keys": ["ui-state"] }),
                    ) {
                        log::error!("Failed to emit cache:invalidate after ui_state cleanup: {e}");
                    }
                }
            }
            Err(e) => {
                log::error!(
                    "Failed to reload ui_state before persisting cleanup for /api/init: {e}"
                );
            }
        }
    }

    // Fetch windowed chat history for active sessions that belong to the
    // selected project. Other active sessions load on-demand when the user
    // switches projects/worktrees.
    let active_sessions: std::collections::HashMap<String, crate::chat::types::Session> =
        if let Some(ref ui) = ui_state {
            let worktree_map: std::collections::HashMap<&str, &crate::projects::types::Worktree> =
                worktrees_by_project
                    .values()
                    .flat_map(|wts| wts.iter())
                    .map(|wt| (wt.id.as_str(), wt))
                    .collect();

            let session_futures: Vec<_> = ui
                .active_session_ids
                .iter()
                .filter_map(|(worktree_id, session_id)| {
                    worktree_map.get(worktree_id.as_str()).map(|wt| {
                        let app = state.app.clone();
                        let wt_id = worktree_id.clone();
                        let wt_path = wt.path.clone();
                        let sess_id = session_id.clone();
                        async move {
                            match crate::chat::get_session(
                                app,
                                wt_id,
                                wt_path,
                                sess_id.clone(),
                                Some(INIT_MESSAGE_WINDOW),
                            )
                            .await
                            {
                                Ok(session) => Some((sess_id, session)),
                                Err(e) => {
                                    log::warn!("Failed to load active session {sess_id}: {e}");
                                    None
                                }
                            }
                        }
                    })
                })
                .collect();

            futures_util::future::join_all(session_futures)
                .await
                .into_iter()
                .flatten()
                .collect()
        } else {
            std::collections::HashMap::new()
        };

    // Serialize projects (always included)
    if let Ok(val) = serde_json::to_value(&projects) {
        response["projects"] = val;
    }

    // Only emit worktrees/sessions keys when we actually have data.
    // Frontend checks `if (data.worktreesByProject)` etc. — omitting the key
    // signals lazy-load via TanStack Query hooks.
    if !worktrees_by_project.is_empty() {
        if let Ok(val) = serde_json::to_value(&worktrees_by_project) {
            response["worktreesByProject"] = val;
        }
    }

    if !sessions_by_worktree.is_empty() {
        if let Ok(val) = serde_json::to_value(&sessions_by_worktree) {
            response["sessionsByWorktree"] = val;
        }
    }

    if !active_sessions.is_empty() {
        if let Ok(val) = serde_json::to_value(&active_sessions) {
            response["activeSessions"] = val;
        }
    }

    if let Ok(app_data_dir) = state.app.path().app_data_dir() {
        response["appDataDir"] = Value::String(app_data_dir.to_string_lossy().to_string());
    }

    match preferences_result {
        Ok(preferences) => {
            if let Ok(val) = serde_json::to_value(&preferences) {
                response["preferences"] = val;
            }
        }
        Err(e) => {
            log::error!("Failed to load preferences for /api/init: {e}");
            response["preferences"] = Value::Null;
        }
    }

    let running_sessions = crate::chat::registry::get_running_sessions();
    response["runningSessions"] = serde_json::to_value(&running_sessions).unwrap_or_default();

    // Replay events: only for running sessions that are also focused (in
    // active_sessions), capped at the last N events per session. The WebSocket
    // reconnect path continues to stream the full event flow.
    if !running_sessions.is_empty() && !active_sessions.is_empty() {
        let focused: std::collections::HashSet<&String> = running_sessions
            .iter()
            .filter(|id| active_sessions.contains_key(id.as_str()))
            .collect();

        if !focused.is_empty() {
            let mut replay_events: Vec<Value> = state
                .app
                .try_state::<WsBroadcaster>()
                .map(|broadcaster| {
                    let mut events: Vec<Value> = focused
                        .iter()
                        .flat_map(|session_id| {
                            let buffered = broadcaster.replay_events(session_id, 0);
                            let start = buffered.len().saturating_sub(INIT_REPLAY_EVENT_CAP);
                            buffered[start..].to_vec()
                        })
                        .filter_map(|(_, json)| serde_json::from_str::<Value>(&json).ok())
                        .collect();
                    events.sort_by_key(|event| {
                        event
                            .get("seq")
                            .and_then(|seq| seq.as_u64())
                            .unwrap_or_default()
                    });
                    events
                })
                .unwrap_or_default();

            replay_events.dedup_by(|a, b| {
                a.get("seq").and_then(|seq| seq.as_u64())
                    == b.get("seq").and_then(|seq| seq.as_u64())
            });

            if !replay_events.is_empty() {
                response["replayEvents"] = Value::Array(replay_events);
            }
        }
    }

    match ui_state {
        Some(cleaned_ui) => {
            if let Ok(val) = serde_json::to_value(&cleaned_ui) {
                response["uiState"] = val;
            }
        }
        None => {
            if let Err(e) = &ui_state_result {
                log::error!("Failed to load ui_state for /api/init: {e}");
            }
            response["uiState"] = Value::Null;
        }
    }

    Json(response).into_response()
}

/// Guess MIME type from file extension.
fn mime_from_extension(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("txt") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        Some("md") => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Serve files from the app data directory (authenticated).
/// Used by the web view to load images, avatars, and other assets
/// that Tauri's asset:// protocol would serve in native mode.
async fn file_handler(
    AxumPath(filepath): AxumPath<String>,
    Query(params): Query<WsAuth>,
    State(state): State<AppState>,
) -> Response {
    // Validate token
    if state.token_required {
        let provided = params.token.unwrap_or_default();
        if !auth::validate_token(&provided, &state.token) {
            return (StatusCode::UNAUTHORIZED, "Invalid token").into_response();
        }
    }

    // Resolve app data directory
    let app_data_dir = match state.app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cannot resolve app data dir",
            )
                .into_response()
        }
    };

    // Build requested path and canonicalize
    let requested = app_data_dir.join(&filepath);
    let canonical = match requested.canonicalize() {
        Ok(p) => p,
        Err(_) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };

    // Security: ensure path is within app data dir (prevents traversal)
    let canonical_base = match app_data_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Cannot resolve base dir").into_response()
        }
    };
    if !canonical.starts_with(&canonical_base) {
        return (StatusCode::FORBIDDEN, "Access denied").into_response();
    }

    // Only serve files, not directories
    if !canonical.is_file() {
        return (StatusCode::NOT_FOUND, "Not a file").into_response();
    }

    // Read and serve the file
    let mime = mime_from_extension(&canonical);
    match tokio::fs::read(&canonical).await {
        Ok(bytes) => Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "private, max-age=3600")
            .body(axum::body::Body::from(bytes))
            .unwrap()
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Cannot read file").into_response(),
    }
}

fn validate_token(params: &WsAuth, state: &AppState) -> Result<(), Response> {
    if state.token_required {
        let provided = params.token.clone().unwrap_or_default();
        if !auth::validate_token(&provided, &state.token) {
            return Err((StatusCode::UNAUTHORIZED, "Invalid token").into_response());
        }
    }
    Ok(())
}

fn canonicalize_known_project_roots(app: &AppHandle) -> Result<Vec<std::path::PathBuf>, Response> {
    let data = crate::projects::storage::load_projects_data(app).map_err(|e| {
        log::warn!("Failed to load projects for project file request: {e}");
        (StatusCode::INTERNAL_SERVER_ERROR, "Cannot load projects").into_response()
    })?;

    let mut roots = Vec::new();
    for project in data.projects {
        if project.is_folder || project.path.is_empty() {
            continue;
        }
        if let Ok(path) = std::path::Path::new(&project.path).canonicalize() {
            roots.push(path);
        }
    }
    for worktree in data.worktrees {
        if let Ok(path) = std::path::Path::new(&worktree.path).canonicalize() {
            roots.push(path);
        }
    }

    Ok(roots)
}

fn path_is_in_known_roots(path: &std::path::Path, roots: &[std::path::PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/// Serve files from known project/worktree directories (authenticated).
/// Used by browser-mode clients for auto-detected project avatars, matching
/// the native asset protocol's project directory allowlist.
async fn project_file_handler(
    AxumPath(filepath): AxumPath<String>,
    Query(params): Query<WsAuth>,
    State(state): State<AppState>,
) -> Response {
    if let Err(response) = validate_token(&params, &state) {
        return response;
    }

    let requested = std::path::PathBuf::from(&filepath);
    if !requested.is_absolute() {
        return (StatusCode::BAD_REQUEST, "Expected absolute file path").into_response();
    }

    let canonical = match requested.canonicalize() {
        Ok(path) => path,
        Err(_) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };
    if !canonical.is_file() {
        return (StatusCode::NOT_FOUND, "Not a file").into_response();
    }

    let roots = match canonicalize_known_project_roots(&state.app) {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    if !path_is_in_known_roots(&canonical, &roots) {
        return (StatusCode::FORBIDDEN, "Access denied").into_response();
    }

    let mime = mime_from_extension(&canonical);
    match tokio::fs::read(&canonical).await {
        Ok(bytes) => Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "private, max-age=3600")
            .body(Body::from(bytes))
            .unwrap()
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Cannot read file").into_response(),
    }
}

fn static_mime_from_extension(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

async fn static_handler(uri: Uri, State(state): State<AppState>) -> Response {
    let raw_path = uri.path().trim_start_matches('/');
    if raw_path.split('/').any(|part| part == "..") {
        return (StatusCode::FORBIDDEN, "Access denied").into_response();
    }

    let index_path = state.dist_path.join("index.html");
    let requested_path = if raw_path.is_empty() {
        index_path.clone()
    } else {
        state.dist_path.join(raw_path)
    };

    let path = match tokio::fs::metadata(&requested_path).await {
        Ok(metadata) if metadata.is_file() => requested_path,
        Ok(metadata) if metadata.is_dir() => requested_path.join("index.html"),
        _ => index_path.clone(),
    };

    let canonical_base = match tokio::fs::canonicalize(&state.dist_path).await {
        Ok(path) => path,
        Err(_) => return (StatusCode::NOT_FOUND, "Frontend dist not found").into_response(),
    };
    let canonical_path = match tokio::fs::canonicalize(&path).await {
        Ok(path) => path,
        Err(_) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };
    if !canonical_path.starts_with(canonical_base) {
        return (StatusCode::FORBIDDEN, "Access denied").into_response();
    }

    let bytes = match tokio::fs::read(&canonical_path).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::NOT_FOUND, "Cannot read file").into_response(),
    };

    let canonical_index = index_path.canonicalize().unwrap_or(index_path);
    let is_index = canonical_path == canonical_index;
    let cache_control = if is_index || canonical_path.ends_with("jean-build.json") {
        "no-store"
    } else {
        "public, max-age=31536000, immutable"
    };

    Response::builder()
        .header(
            header::CONTENT_TYPE,
            static_mime_from_extension(&canonical_path),
        )
        .header(header::CACHE_CONTROL, cache_control)
        .body(Body::from(bytes))
        .unwrap()
}

fn parse_bind_ip(host: &str) -> Result<IpAddr, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("Bind address cannot be empty".to_string());
    }

    if trimmed.eq_ignore_ascii_case("localhost") {
        return Ok(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }

    trimmed
        .parse::<IpAddr>()
        .map_err(|_| format!("Invalid bind address '{trimmed}'. Use an IP address or 'localhost'"))
}

pub(crate) fn validate_bind_host(host: &str) -> Result<String, String> {
    let trimmed = host.trim();
    parse_bind_ip(trimmed)?;

    if trimmed.eq_ignore_ascii_case("localhost") {
        Ok("localhost".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

fn display_host_for_bind_ip(bind_ip: IpAddr) -> String {
    display_ip_for_bind_ip_with_candidates(
        bind_ip,
        get_if_addrs()
            .into_iter()
            .flatten()
            .map(|interface| interface.ip()),
    )
    .to_string()
}

fn display_ip_for_bind_ip_with_candidates(
    bind_ip: IpAddr,
    candidates: impl IntoIterator<Item = IpAddr>,
) -> IpAddr {
    if !bind_ip.is_unspecified() {
        return bind_ip;
    }

    let mut ipv4_candidate = None;
    let mut ipv6_candidate = None;

    for ip in candidates {
        if !is_displayable_bind_ip_candidate(ip) {
            continue;
        }

        match ip {
            IpAddr::V4(_) if ipv4_candidate.is_none() => ipv4_candidate = Some(ip),
            IpAddr::V6(_) if ipv6_candidate.is_none() => ipv6_candidate = Some(ip),
            _ => {}
        }
    }

    match bind_ip {
        IpAddr::V4(_) => ipv4_candidate.unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        IpAddr::V6(_) => ipv6_candidate
            .or(ipv4_candidate)
            .unwrap_or(IpAddr::V6(Ipv6Addr::LOCALHOST)),
    }
}

fn is_displayable_bind_ip_candidate(ip: IpAddr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }

    !matches!(ip, IpAddr::V6(v6) if v6.is_unicast_link_local())
}

fn format_http_url(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    }
}

pub fn list_bind_host_options() -> Vec<BindHostOption> {
    let mut seen = HashSet::from([
        "127.0.0.1".to_string(),
        "0.0.0.0".to_string(),
        "::1".to_string(),
        "::".to_string(),
    ]);
    let mut options = vec![
        BindHostOption {
            host: "127.0.0.1".to_string(),
            label: "This device only (localhost)".to_string(),
        },
        BindHostOption {
            host: "0.0.0.0".to_string(),
            label: "All interfaces".to_string(),
        },
    ];
    let mut detected = Vec::new();

    if let Ok(interfaces) = get_if_addrs() {
        for interface in interfaces {
            let ip = interface.ip();
            if !is_displayable_bind_ip_candidate(ip) {
                continue;
            }

            let host = ip.to_string();
            if !seen.insert(host.clone()) {
                continue;
            }

            detected.push(BindHostOption {
                label: bind_host_option_label(&interface.name, ip),
                host,
            });
        }
    }

    detected.sort_by(|left, right| {
        bind_host_option_rank(&left.host)
            .cmp(&bind_host_option_rank(&right.host))
            .then_with(|| left.label.cmp(&right.label))
    });
    options.extend(detected);
    options
}

fn bind_host_option_label(interface_name: &str, ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) if is_tailscale_ipv4(v4) => format!("Tailscale ({v4})"),
        IpAddr::V6(v6) if is_tailscale_ipv6(v6) => format!("Tailscale ({v6})"),
        IpAddr::V4(v4) if v4.is_private() => format!("Local network ({interface_name}: {v4})"),
        IpAddr::V4(v4) => format!("{interface_name} ({v4})"),
        IpAddr::V6(v6) => format!("{interface_name} ({v6})"),
    }
}

fn bind_host_option_rank(host: &str) -> u8 {
    host.parse::<IpAddr>()
        .map(|ip| match ip {
            IpAddr::V4(v4) if is_tailscale_ipv4(v4) => 0,
            IpAddr::V6(v6) if is_tailscale_ipv6(v6) => 0,
            IpAddr::V4(v4) if v4.is_private() => 1,
            IpAddr::V4(_) => 2,
            IpAddr::V6(_) => 3,
        })
        .unwrap_or(4)
}

fn is_tailscale_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn is_tailscale_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
}

/// Get current server status. Called from dispatch.
pub async fn get_server_status(app: AppHandle) -> ServerStatus {
    match app.try_state::<Arc<Mutex<Option<HttpServerHandle>>>>() {
        Some(handle_state) => {
            let handle = handle_state.lock().await;
            match handle.as_ref() {
                Some(h) => ServerStatus {
                    running: true,
                    url: Some(h.url.clone()),
                    token: Some(h.token.clone()),
                    port: Some(h.port),
                    bind_host: Some(h.bind_host.clone()),
                    localhost_only: Some(h.localhost_only),
                },
                None => ServerStatus {
                    running: false,
                    url: None,
                    token: None,
                    port: None,
                    bind_host: None,
                    localhost_only: None,
                },
            }
        }
        None => ServerStatus {
            running: false,
            url: None,
            token: None,
            port: None,
            bind_host: None,
            localhost_only: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        bind_host_option_label, bind_host_option_rank, display_host_for_bind_ip,
        display_ip_for_bind_ip_with_candidates, format_http_url, is_tailscale_ipv4, parse_bind_ip,
        path_is_in_known_roots, validate_bind_host,
    };
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn parse_bind_ip_accepts_localhost_and_ip_literals() {
        assert_eq!(
            parse_bind_ip("localhost").unwrap(),
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        );
        assert_eq!(
            parse_bind_ip("100.64.0.1").unwrap(),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))
        );
        assert_eq!(
            parse_bind_ip("::1").unwrap(),
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        );
    }

    #[test]
    fn parse_bind_ip_rejects_invalid_values() {
        let error = parse_bind_ip("tailscale").unwrap_err();
        assert!(error.contains("Invalid bind address"));

        let empty_error = parse_bind_ip("").unwrap_err();
        assert!(empty_error.contains("cannot be empty"));
    }

    #[test]
    fn validate_bind_host_trims_and_normalizes_localhost() {
        assert_eq!(validate_bind_host(" LOCALHOST ").unwrap(), "localhost");
        assert_eq!(
            validate_bind_host(" 100.110.76.47 ").unwrap(),
            "100.110.76.47"
        );
    }

    #[test]
    fn display_host_uses_specific_bind_ip_directly() {
        assert_eq!(
            display_host_for_bind_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))),
            "100.64.0.1"
        );
        assert_eq!(
            display_host_for_bind_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)),
            "::1"
        );
    }

    #[test]
    fn ipv4_wildcard_display_host_uses_first_valid_ipv4_candidate() {
        assert_eq!(
            display_ip_for_bind_ip_with_candidates(
                IpAddr::V4(Ipv4Addr::UNSPECIFIED),
                [
                    IpAddr::V6(Ipv6Addr::LOCALHOST),
                    IpAddr::V4(Ipv4Addr::new(192, 168, 1, 25)),
                    IpAddr::V6("fd7a:115c:a1e0::1".parse::<Ipv6Addr>().unwrap()),
                ],
            ),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 25))
        );
    }

    #[test]
    fn ipv6_wildcard_display_host_prefers_valid_ipv6_candidate() {
        assert_eq!(
            display_ip_for_bind_ip_with_candidates(
                IpAddr::V6(Ipv6Addr::UNSPECIFIED),
                [
                    IpAddr::V4(Ipv4Addr::new(192, 168, 1, 25)),
                    IpAddr::V6("fd7a:115c:a1e0::1".parse::<Ipv6Addr>().unwrap()),
                ],
            ),
            IpAddr::V6("fd7a:115c:a1e0::1".parse::<Ipv6Addr>().unwrap())
        );
    }

    #[test]
    fn ipv6_wildcard_display_host_falls_back_to_ipv4_when_needed() {
        assert_eq!(
            display_ip_for_bind_ip_with_candidates(
                IpAddr::V6(Ipv6Addr::UNSPECIFIED),
                [IpAddr::V4(Ipv4Addr::new(192, 168, 1, 25))],
            ),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 25))
        );
    }

    #[test]
    fn ipv6_wildcard_display_host_falls_back_to_ipv6_localhost_when_no_candidates() {
        assert_eq!(
            display_ip_for_bind_ip_with_candidates(IpAddr::V6(Ipv6Addr::UNSPECIFIED), []),
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        );
    }

    #[test]
    fn format_http_url_wraps_ipv6_hosts() {
        assert_eq!(
            format_http_url("100.64.0.1", 3456),
            "http://100.64.0.1:3456"
        );
        assert_eq!(format_http_url("::1", 3456), "http://[::1]:3456");
    }

    #[test]
    fn wildcard_display_urls_never_use_unspecified_hosts() {
        let ipv6_url = format_http_url(
            &display_ip_for_bind_ip_with_candidates(
                IpAddr::V6(Ipv6Addr::UNSPECIFIED),
                [IpAddr::V6("fd7a:115c:a1e0::1".parse::<Ipv6Addr>().unwrap())],
            )
            .to_string(),
            3456,
        );
        assert_eq!(ipv6_url, "http://[fd7a:115c:a1e0::1]:3456");

        let fallback_url = format_http_url(
            &display_ip_for_bind_ip_with_candidates(IpAddr::V6(Ipv6Addr::UNSPECIFIED), [])
                .to_string(),
            3456,
        );
        assert_ne!(fallback_url, "http://[::]:3456");
        assert_eq!(fallback_url, "http://[::1]:3456");
    }

    #[test]
    fn tailscale_ipv4_detection_matches_cgnat_range() {
        assert!(is_tailscale_ipv4(Ipv4Addr::new(100, 110, 76, 47)));
        assert!(!is_tailscale_ipv4(Ipv4Addr::new(100, 63, 0, 1)));
        assert!(!is_tailscale_ipv4(Ipv4Addr::new(192, 168, 1, 10)));
    }

    #[test]
    fn tailscale_ipv6_detection_matches_known_prefix() {
        assert!(super::is_tailscale_ipv6(
            "fd7a:115c:a1e0::1".parse::<Ipv6Addr>().unwrap()
        ));
        assert!(!super::is_tailscale_ipv6(
            "fd00::1".parse::<Ipv6Addr>().unwrap()
        ));
    }

    #[test]
    fn bind_host_labels_prioritize_tailscale_and_lan_ips() {
        assert_eq!(
            bind_host_option_label("utun4", IpAddr::V4(Ipv4Addr::new(100, 110, 76, 47))),
            "Tailscale (100.110.76.47)"
        );
        assert_eq!(
            bind_host_option_label("en0", IpAddr::V4(Ipv4Addr::new(192, 168, 18, 17))),
            "Local network (en0: 192.168.18.17)"
        );
        assert!(bind_host_option_rank("100.110.76.47") < bind_host_option_rank("192.168.18.17"));
    }

    #[test]
    fn bind_host_options_include_default_presets() {
        let options = super::list_bind_host_options();
        assert!(options.iter().any(|option| option.host == "127.0.0.1"));
        assert!(options.iter().any(|option| option.host == "0.0.0.0"));
    }

    #[test]
    fn selected_project_id_for_init_prefers_browser_state() {
        let ui_state = crate::UIState {
            active_project_id: Some("disk-project".to_string()),
            ..Default::default()
        };

        assert_eq!(
            super::selected_project_id_for_init(Some("browser-project"), Some(&ui_state)),
            Some("browser-project".to_string())
        );
    }

    #[test]
    fn selected_project_id_for_init_falls_back_to_ui_state() {
        let ui_state = crate::UIState {
            active_project_id: Some("disk-project".to_string()),
            ..Default::default()
        };

        assert_eq!(
            super::selected_project_id_for_init(None, Some(&ui_state)),
            Some("disk-project".to_string())
        );
    }

    #[test]
    fn selected_project_id_for_init_ignores_empty_values() {
        let ui_state = crate::UIState {
            active_project_id: Some(String::new()),
            ..Default::default()
        };

        assert_eq!(
            super::selected_project_id_for_init(Some(""), Some(&ui_state)),
            None
        );
    }

    #[test]
    fn test_path_is_in_known_roots_allows_nested_project_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("project");
        let nested = root.join("public").join("favicon.png");
        std::fs::create_dir_all(nested.parent().expect("nested parent")).expect("create dirs");
        std::fs::write(&nested, "png").expect("write file");

        let canonical_root = root.canonicalize().expect("canonical root");
        let canonical_nested = nested.canonicalize().expect("canonical nested");

        assert!(path_is_in_known_roots(&canonical_nested, &[canonical_root]));
    }

    #[test]
    fn test_path_is_in_known_roots_rejects_sibling_prefix() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("project");
        let sibling = dir.path().join("project-other").join("favicon.png");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::create_dir_all(sibling.parent().expect("sibling parent")).expect("create sibling");
        std::fs::write(&sibling, "png").expect("write file");

        let canonical_root = root.canonicalize().expect("canonical root");
        let canonical_sibling = sibling.canonicalize().expect("canonical sibling");

        assert!(!path_is_in_known_roots(
            &canonical_sibling,
            &[canonical_root]
        ));
    }
}
