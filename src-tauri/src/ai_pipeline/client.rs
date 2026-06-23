//! Thin async HTTP client for the internal AI pipeline dashboard.
//!
//! Only one endpoint is consumed: `GET {base}/prs`, which returns the open PRs
//! the pipeline tracks, grouped by repo. The dashboard runs on internal infra
//! behind a self-signed cert, so the client accepts invalid certs — same trade
//! off as the Jenkins preview-freshness probe (`jenkins/freshness.rs`). This is
//! gated behind a user-configured URL for internal infrastructure.

use once_cell::sync::Lazy;
use std::time::Duration;

/// Shared HTTP client: built once and reused (cloning a `Client` is cheap — it's
/// `Arc`-backed). Accepts the internal dashboard's self-signed certificate.
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .danger_accept_invalid_certs(true)
        .build()
        .unwrap_or_default()
});

/// Fetch the raw `/prs` JSON from the dashboard.
///
/// `base_url` must already be trimmed (no trailing slash) — see
/// [`super::config::resolve_dashboard_url`].
pub async fn fetch_prs(base_url: &str) -> Result<serde_json::Value, String> {
    let url = format!("{base_url}/prs");

    let response = CLIENT
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("AI pipeline dashboard request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("AI pipeline dashboard error ({status}): {text}"));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse AI pipeline dashboard response: {e}"))
}
