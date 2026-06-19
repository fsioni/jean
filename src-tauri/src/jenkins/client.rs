//! Thin async HTTP client over the Jenkins REST API.
//!
//! Auth is HTTP Basic with `user:apiToken`. Parsing lives in [`super::parse`]
//! (unit-tested); this layer only does I/O. Mutating calls (re-run / restart)
//! attach a CSRF crumb when the controller issues one.

use serde_json::Value;

use super::parse;
use super::types::{JenkinsBuild, JenkinsStage};

/// `tree` filter for the builds listing — keeps the payload small.
///
/// `lastBuiltRevision[SHA1,branch[name,SHA1]]` exposes the git commit the build
/// was built from (git plugin `BuildData`), used for preview freshness.
const BUILDS_TREE: &str = "builds[number,result,building,timestamp,duration,url,\
actions[parameters[name,value],lastBuiltRevision[SHA1,branch[name,SHA1]],remoteUrls,\
causes[shortDescription,upstreamProject,upstreamBuild]]]{0,30}";

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
        let url = format!("{}/{build}/wfapi/describe", self.job_url(job));
        let body = self.get_text(&url, &[]).await?;
        parse::parse_stages(&body)
    }

    /// Fetch the build parameters of a specific build (used to replay a re-run).
    pub async fn fetch_build_parameters(
        &self,
        job: &str,
        build: u64,
    ) -> Result<Vec<(String, String)>, String> {
        let url = format!("{}/{build}/api/json", self.job_url(job));
        let body = self
            .get_text(&url, &[("tree", "actions[parameters[name,value]]")])
            .await?;
        let root: Value = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse build parameters: {e}"))?;
        Ok(parse::extract_parameters(root.get("actions")))
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

    /// Trigger a new build of `job` with the given parameters.
    pub async fn trigger_with_parameters(
        &self,
        job: &str,
        params: &[(String, String)],
    ) -> Result<(), String> {
        let url = format!("{}/buildWithParameters", self.job_url(job));
        let form: Vec<(&str, String)> = params
            .iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        self.post_form(&url, &form).await
    }

    /// Restart a declarative pipeline from a given stage (e.g. `"Integration tests"`).
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
            client.job_url("build-and-test"),
            "https://jenkins.example.com/job/build-and-test"
        );
    }
}
