//! Parent-side local socket for Jean MCP stdio helpers.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::jean_mcp_core::{call_tool, jsonrpc_error, jsonrpc_ok};

#[derive(Debug)]
pub struct JeanMcpSocketHandle {
    pub shutdown_tx: tokio::sync::oneshot::Sender<()>,
    pub path: PathBuf,
    pub token: String,
}

pub fn socket_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(dir.join("jean-mcp.sock"))
}

pub async fn get_socket_status(app: AppHandle) -> (bool, Option<String>, Option<String>) {
    match app.try_state::<Arc<Mutex<Option<JeanMcpSocketHandle>>>>() {
        Some(state) => {
            let guard = state.lock().await;
            match guard.as_ref() {
                Some(handle) => (
                    true,
                    Some(handle.path.to_string_lossy().to_string()),
                    Some(handle.token.clone()),
                ),
                None => (false, None, None),
            }
        }
        None => (false, None, None),
    }
}

#[cfg(unix)]
pub async fn start_socket_server(
    app: AppHandle,
    path: PathBuf,
    token: String,
) -> Result<JeanMcpSocketHandle, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create Jean MCP socket dir: {e}"))?;
    }
    if path.exists() {
        let _ = tokio::fs::remove_file(&path).await;
    }

    let listener = UnixListener::bind(&path)
        .map_err(|e| format!("Failed to bind Jean MCP socket {}: {e}", path.display()))?;
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
    let path_for_task = path.clone();
    let token_for_task = token.clone();

    tokio::spawn(async move {
        log::info!(
            "Jean MCP stdio proxy socket listening at {}",
            path_for_task.display()
        );
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    log::info!("Jean MCP stdio proxy socket shutting down");
                    break;
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _addr)) => {
                            let app = app.clone();
                            let expected_token = token_for_task.clone();
                            tokio::spawn(async move {
                                let (read_half, mut write_half) = stream.into_split();
                                let mut reader = BufReader::new(read_half);
                                let mut line = String::new();
                                let response = match reader.read_line(&mut line).await {
                                    Ok(0) => json!({"error":"empty request"}),
                                    Ok(_) => handle_socket_request(&app, &expected_token, &line).await,
                                    Err(e) => json!({"error": format!("read failed: {e}")}),
                                };
                                if let Ok(encoded) = serde_json::to_string(&response) {
                                    let _ = write_half.write_all(encoded.as_bytes()).await;
                                    let _ = write_half.write_all(b"\n").await;
                                    let _ = write_half.flush().await;
                                }
                            });
                        }
                        Err(e) => log::warn!("Jean MCP socket accept failed: {e}"),
                    }
                }
            }
        }
        let _ = tokio::fs::remove_file(&path_for_task).await;
    });

    Ok(JeanMcpSocketHandle {
        shutdown_tx,
        path,
        token,
    })
}

#[cfg(not(unix))]
pub async fn start_socket_server(
    _app: AppHandle,
    _path: PathBuf,
    _token: String,
) -> Result<JeanMcpSocketHandle, String> {
    Err("Jean MCP stdio currently requires Unix domain sockets".to_string())
}

async fn handle_socket_request(app: &AppHandle, expected_token: &str, line: &str) -> Value {
    let body: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({"error": format!("invalid json: {e}")}),
    };
    let provided = body.get("token").and_then(|v| v.as_str()).unwrap_or("");
    if !crate::http_server::auth::validate_token(provided, expected_token) {
        return json!({"error":"unauthorized"});
    }

    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let arguments = body.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let source = body
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("anon");
    let depth = body.get("depth").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    match call_tool(app, name, arguments, source, depth).await {
        Ok(result) => jsonrpc_ok(None, result),
        Err(e) => jsonrpc_error(None, e.code, &e.message),
    }
}
