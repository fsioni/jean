//! Thin async HTTP client over the Jenkins REST API.
//!
//! Auth is HTTP Basic with `user:apiToken`. Parsing lives in [`super::parse`]
//! (unit-tested); this layer only does I/O. Mutating calls (re-run / restart)
//! attach a CSRF crumb when the controller issues one.

use serde_json::Value;

use super::parse;
use super::types::{JenkinsBuild, JenkinsStage};

/// `tree` filter for the builds listing — keeps the payload small.
const BUILDS_TREE: &str = "builds[number,result,building,timestamp,duration,url,\
actions[parameters[name,value],causes[shortDescription,upstreamProject,upstreamBuild]]]{0,30}";

/// Async Jenkins client scoped to one controller + credentials.
pub struct JenkinsClient {
    base_url: String,
    user: String,
    token: String,
    http: reqwest::Client,
}

impl JenkinsClient {
    pub fn new(base_url: &str, user: &str, token: &str) -> Self {
        Self {
            base_url: base_url.trim().trim_end_matches('/').to_string(),
            user: user.trim().to_string(),
            token: token.trim().to_string(),
            http: reqwest::Client::new(),
        }
    }

    fn job_url(&self, job: &str) -> String {
        format!("{}/job/{}", self.base_url, job)
    }

    /// GET a URL with optional query params, returning the body or a mapped error.
    async fn get_text(&self, url: &str, query: &[(&str, &str)]) -> Result<String, String> {
        let resp = self
            .http
            .get(url)
            .basic_auth(&self.user, Some(&self.token))
            .query(query)
            .send()
            .await
            .map_err(|e| format!("Jenkins request failed: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!(
                "Jenkins returned {status}: {}",
                body.chars().take(200).collect::<String>()
            ));
        }
        Ok(body)
    }

    /// List recent builds of a job (newest first).
    pub async fn fetch_builds(&self, job: &str) -> Result<Vec<JenkinsBuild>, String> {
        let url = format!("{}/api/json", self.job_url(job));
        let body = self.get_text(&url, &[("tree", BUILDS_TREE)]).await?;
        parse::parse_builds(&body)
    }

    /// Fetch the controller build queue as raw JSON (parsed by `parse::find_queued_for_pr`).
    pub async fn fetch_queue(&self) -> Result<String, String> {
        let url = format!("{}/queue/api/json", self.base_url);
        self.get_text(
            &url,
            &[(
                "tree",
                "items[id,why,blocked,buildable,stuck,inQueueSince,task[name],params]",
            )],
        )
        .await
    }

    /// Fetch the declarative-pipeline stage breakdown of a build.
    pub async fn fetch_stages(&self, job: &str, build: u64) -> Result<Vec<JenkinsStage>, String> {
        let body = self.fetch_stages_json(job, build).await?;
        parse::parse_stages(&body)
    }

    /// Raw `wfapi/describe` body — keeps the per-stage `id` the failure report
    /// needs to drill into a stage (`parse_stages` drops it).
    ///
    /// `fullStages=true` inlines each stage's `stageFlowNodes`, so the retry
    /// attempts of the flaky stage come along for free instead of costing one
    /// extra request per worktree per poll cycle.
    pub async fn fetch_stages_json(&self, job: &str, build: u64) -> Result<String, String> {
        let url = format!("{}/{build}/wfapi/describe", self.job_url(job));
        self.get_text(&url, &[("fullStages", "true")]).await
    }

    /// Base URL of the controller, for absolutizing its relative `_links`.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Raw `wfapi/describe` of ONE stage node: its `stageFlowNodes` are the
    /// individual steps, each with its own status and log link.
    pub async fn fetch_stage_node_json(
        &self,
        job: &str,
        build: u64,
        node_id: &str,
    ) -> Result<String, String> {
        let url = format!(
            "{}/{build}/execution/node/{node_id}/wfapi/describe",
            self.job_url(job)
        );
        self.get_text(&url, &[]).await
    }

    /// Log of one pipeline step (`{ text, consoleUrl, … }`, HTML-escaped links).
    pub async fn fetch_node_log_json(
        &self,
        job: &str,
        build: u64,
        node_id: &str,
    ) -> Result<String, String> {
        let url = format!(
            "{}/{build}/execution/node/{node_id}/wfapi/log",
            self.job_url(job)
        );
        self.get_text(&url, &[]).await
    }

    /// Last `max_bytes` of a build's console output.
    ///
    /// Jenkins console logs run to hundreds of KB; `logText/progressiveText`
    /// takes a byte offset and a HEAD request reports the total via the
    /// `X-Text-Size` header, so only the tail crosses the wire.
    pub async fn fetch_console_tail(
        &self,
        job: &str,
        build: u64,
        max_bytes: u64,
    ) -> Result<String, String> {
        let url = format!("{}/{build}/logText/progressiveText", self.job_url(job));
        let head = self
            .http
            .head(&url)
            .basic_auth(&self.user, Some(&self.token))
            .query(&[("start", "0")])
            .send()
            .await
            .map_err(|e| format!("Jenkins log HEAD failed: {e}"))?;
        let total = head
            .headers()
            .get("x-text-size")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let start = total.saturating_sub(max_bytes);
        self.get_text(&url, &[("start", &start.to_string())]).await
    }

    /// JUnit report of a build. `Ok(None)` when the build published no tests
    /// (Jenkins answers 404) — an absent report is normal, not an error.
    pub async fn fetch_test_report(&self, job: &str, build: u64) -> Result<Option<String>, String> {
        let url = format!("{}/{build}/testReport/api/json", self.job_url(job));
        match self
            .get_text(
                &url,
                // `errorDetails` is empty for some runners (jest puts everything
                // in `errorStackTrace`), so both are fetched — verified against
                // Planexpo's unit-tests #7031.
                &[(
                    "tree",
                    "failCount,suites[cases[className,name,status,errorDetails,errorStackTrace]]",
                )],
            )
            .await
        {
            Ok(body) => Ok(Some(body)),
            // 404 = no test report on this build; anything else is a real error.
            Err(e) if e.contains("404") => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Fetch a CSRF crumb `(header_name, value)`, or `None` if disabled/unavailable.
    async fn crumb(&self) -> Option<(String, String)> {
        let url = format!("{}/crumbIssuer/api/json", self.base_url);
        let body = self.get_text(&url, &[]).await.ok()?;
        let v: Value = serde_json::from_str(&body).ok()?;
        let field = v.get("crumbRequestField")?.as_str()?.to_string();
        let crumb = v.get("crumb")?.as_str()?.to_string();
        Some((field, crumb))
    }

    /// POST a form to a URL, attaching a crumb when one is available.
    async fn post_form(&self, url: &str, form: &[(&str, String)]) -> Result<(), String> {
        let mut req = self
            .http
            .post(url)
            .basic_auth(&self.user, Some(&self.token));
        if let Some((field, crumb)) = self.crumb().await {
            req = req.header(field, crumb);
        }
        let resp = req
            .form(form)
            .send()
            .await
            .map_err(|e| format!("Jenkins POST failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Jenkins POST returned {status}: {}",
                body.chars().take(200).collect::<String>()
            ));
        }
        Ok(())
    }

    /// Restart a declarative pipeline from a given stage (e.g. `"Cypress Unified"`).
    pub async fn restart_stage(&self, job: &str, build: u64, stage: &str) -> Result<(), String> {
        let url = format!("{}/{build}/restart/restart", self.job_url(job));
        self.post_form(&url, &[("stageName", stage.to_string())])
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_url_and_credentials() {
        let client = JenkinsClient::new("  https://jenkins.example.com/  ", " ci-user ", " tok ");
        assert_eq!(client.base_url, "https://jenkins.example.com");
        assert_eq!(client.user, "ci-user");
        assert_eq!(client.token, "tok");
        assert_eq!(
            client.job_url("unified-build-test-deploy"),
            "https://jenkins.example.com/job/unified-build-test-deploy"
        );
    }
}
