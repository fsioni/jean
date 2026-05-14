//! Stdio MCP transport for Jean.
//!
//! This process is launched by a local CLI as an MCP stdio server. It proxies
//! tools/call requests over a Jean-owned local Unix socket to the already
//! running desktop app, avoiding HTTP ports while preserving in-process app
//! command dispatch in the parent.

use std::io::{BufRead, BufReader, Write};

use serde_json::{json, Value};

use crate::jean_mcp_core::{
    initialize_result, jsonrpc_error, jsonrpc_ok, tools_list_result, JEAN_MCP_DEPTH_ENV,
    JEAN_MCP_SESSION_ENV, JEAN_MCP_SOCKET_ENV, JEAN_MCP_TOKEN_ENV,
};

pub fn run_stdio_server() -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("Failed to read stdin: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let response = handle_message(&line);
        if let Some(response) = response {
            let encoded = serde_json::to_string(&response)
                .map_err(|e| format!("Failed to encode MCP response: {e}"))?;
            writeln!(stdout, "{encoded}").map_err(|e| format!("Failed to write stdout: {e}"))?;
            stdout
                .flush()
                .map_err(|e| format!("Failed to flush stdout: {e}"))?;
        }
    }

    Ok(())
}

fn handle_message(line: &str) -> Option<Value> {
    let body: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(jsonrpc_error(None, -32700, &format!("Parse error: {e}"))),
    };
    let id = body.get("id").cloned();
    let method = body.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = body.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => Some(jsonrpc_ok(id, initialize_result())),
        "notifications/initialized" => None,
        "tools/list" => Some(jsonrpc_ok(id, tools_list_result())),
        "tools/call" => Some(match proxy_tool_call(params) {
            Ok(result) => jsonrpc_ok(id, result),
            Err(e) => jsonrpc_error(id, -32000, &e),
        }),
        "ping" => Some(jsonrpc_ok(id, json!({}))),
        _ => Some(jsonrpc_error(
            id,
            -32601,
            &format!("Method not found: {method}"),
        )),
    }
}

fn proxy_tool_call(params: Value) -> Result<Value, String> {
    let socket =
        std::env::var(JEAN_MCP_SOCKET_ENV).map_err(|_| format!("Missing {JEAN_MCP_SOCKET_ENV}"))?;
    let token =
        std::env::var(JEAN_MCP_TOKEN_ENV).map_err(|_| format!("Missing {JEAN_MCP_TOKEN_ENV}"))?;
    let source = std::env::var(JEAN_MCP_SESSION_ENV).unwrap_or_else(|_| "anon".to_string());
    let depth = std::env::var(JEAN_MCP_DEPTH_ENV)
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing 'name'".to_string())?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    proxy_to_parent(
        &socket,
        json!({
            "token": token,
            "source": source,
            "depth": depth,
            "name": name,
            "arguments": arguments,
        }),
    )
}

#[cfg(unix)]
fn proxy_to_parent(socket: &str, request: Value) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket)
        .map_err(|e| format!("Failed to connect Jean MCP socket {socket}: {e}"))?;
    let encoded = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to encode Jean MCP socket request: {e}"))?;
    writeln!(stream, "{encoded}").map_err(|e| format!("Failed to write Jean MCP socket: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("Failed to flush Jean MCP socket: {e}"))?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("Failed to read Jean MCP socket response: {e}"))?;
    let response: Value = serde_json::from_str(&line)
        .map_err(|e| format!("Failed to parse Jean MCP socket response: {e}"))?;
    if let Some(error) = response.get("error").and_then(|v| v.as_str()) {
        return Err(error.to_string());
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg(not(unix))]
fn proxy_to_parent(_socket: &str, _request: Value) -> Result<Value, String> {
    Err("Jean MCP stdio currently requires a Unix domain socket".to_string())
}
