//! Jean MCP HTTP endpoint.
//!
//! Kept as an optional/manual transport. Auto-injected local CLIs use MCP
//! stdio (`src-tauri/src/jean_mcp_stdio.rs`) instead of this HTTP listener.

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use super::auth;
use super::server::AppState;

pub(super) async fn mcp_handler(
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Response {
    let needs_token = state.token_required || !state.localhost_only;
    if needs_token && !is_valid_mcp_auth(&headers, &query, &state.token) {
        return Json(crate::jean_mcp_core::jsonrpc_error(
            body.get("id").cloned(),
            -32001,
            "Unauthorized",
        ))
        .into_response();
    }

    let id = body.get("id").cloned();
    let method = body.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = body.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "initialize" => Json(crate::jean_mcp_core::jsonrpc_ok(
            id,
            crate::jean_mcp_core::initialize_result(),
        ))
        .into_response(),
        "notifications/initialized" => StatusCode::NO_CONTENT.into_response(),
        "tools/list" => Json(crate::jean_mcp_core::jsonrpc_ok(
            id,
            crate::jean_mcp_core::tools_list_result(),
        ))
        .into_response(),
        "tools/call" => match call_tool(&state, &headers, params).await {
            Ok(result) => Json(crate::jean_mcp_core::jsonrpc_ok(id, result)).into_response(),
            Err(e) => {
                Json(crate::jean_mcp_core::jsonrpc_error(id, e.code, &e.message)).into_response()
            }
        },
        "ping" => Json(crate::jean_mcp_core::jsonrpc_ok(id, json!({}))).into_response(),
        _ => Json(crate::jean_mcp_core::jsonrpc_error(
            id,
            -32601,
            &format!("Method not found: {method}"),
        ))
        .into_response(),
    }
}

fn is_valid_mcp_auth(
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    expected_token: &str,
) -> bool {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));

    let query_token = query.get("token").map(String::as_str);

    bearer
        .into_iter()
        .chain(query_token)
        .any(|provided| auth::validate_token(provided, expected_token))
}

async fn call_tool(
    state: &AppState,
    headers: &HeaderMap,
    params: Value,
) -> Result<Value, crate::jean_mcp_core::ToolError> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| crate::jean_mcp_core::ToolError::invalid_params("missing 'name'"))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let depth = headers
        .get("x-jean-mcp-depth")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let source = headers
        .get("x-jean-session")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("anon");

    crate::jean_mcp_core::call_tool(&state.app, name, arguments, source, depth).await
}

#[cfg(test)]
mod tests {
    use super::is_valid_mcp_auth;
    use axum::http::{HeaderMap, HeaderValue};
    use std::collections::HashMap;

    #[test]
    fn mcp_auth_accepts_bearer_header() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer expected"));
        let query = HashMap::new();
        assert!(is_valid_mcp_auth(&headers, &query, "expected"));
    }

    #[test]
    fn mcp_auth_accepts_query_token() {
        let headers = HeaderMap::new();
        let query = HashMap::from([("token".to_string(), "expected".to_string())]);
        assert!(is_valid_mcp_auth(&headers, &query, "expected"));
    }

    #[test]
    fn mcp_auth_rejects_invalid_token() {
        let headers = HeaderMap::new();
        let query = HashMap::from([("token".to_string(), "wrong".to_string())]);
        assert!(!is_valid_mcp_auth(&headers, &query, "expected"));
    }

    #[test]
    fn mcp_auth_accepts_valid_query_token_even_with_invalid_bearer_header() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer wrong"));
        let query = HashMap::from([("token".to_string(), "expected".to_string())]);
        assert!(is_valid_mcp_auth(&headers, &query, "expected"));
    }
}
