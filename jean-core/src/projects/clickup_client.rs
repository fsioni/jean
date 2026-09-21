//! Minimal HTTP client for the ClickUp REST API v2.
//!
//! Isolated module (zero overlap with upstream files) used by the native
//! ClickUp integration. Authentication uses a personal API token passed
//! verbatim in the `Authorization` header (no `Bearer` prefix).
//!
//! Docs: https://developer.clickup.com/docs/authentication

use once_cell::sync::Lazy;
use std::time::Duration;

const CLICKUP_API_BASE: &str = "https://api.clickup.com/api/v2";

/// Shared HTTP client: built once and reused so the TCP/TLS connection pool is
/// kept alive across requests (cloning a `Client` is cheap — it's `Arc`-backed).
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_default()
});

/// Map a non-success ClickUp response into a user-facing error string.
fn map_error(status: reqwest::StatusCode, text: String) -> String {
    match status.as_u16() {
        401 => "ClickUp API token is invalid. Update it in Settings → Integrations.".to_string(),
        429 => "ClickUp API rate limit reached. Try again in a moment.".to_string(),
        _ => format!("ClickUp API error ({status}): {text}"),
    }
}

/// Perform a `GET` request against the ClickUp API and return the parsed JSON.
///
/// `path` must start with a `/` (e.g. `/task/86abc`).
pub async fn clickup_get(token: &str, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{CLICKUP_API_BASE}{path}");

    let response = CLIENT
        .get(&url)
        .header("Authorization", token)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("ClickUp API request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(map_error(status, text));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse ClickUp response: {e}"))
}

/// Perform a `PUT` request against the ClickUp API with a JSON body.
pub async fn clickup_put(
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("{CLICKUP_API_BASE}{path}");

    let response = CLIENT
        .put(&url)
        .header("Authorization", token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ClickUp API request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(map_error(status, text));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse ClickUp response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_401_to_token_message() {
        let msg = map_error(reqwest::StatusCode::UNAUTHORIZED, "nope".to_string());
        assert!(msg.contains("token is invalid"));
    }

    #[test]
    fn maps_429_to_rate_limit_message() {
        let msg = map_error(reqwest::StatusCode::TOO_MANY_REQUESTS, String::new());
        assert!(msg.contains("rate limit"));
    }

    #[test]
    fn maps_other_status_with_body() {
        let msg = map_error(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "boom".to_string(),
        );
        assert!(msg.contains("500"));
        assert!(msg.contains("boom"));
    }
}
