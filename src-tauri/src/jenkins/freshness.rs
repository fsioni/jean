//! Preview freshness: is the live PR preview up to date with the PR head?
//!
//! Jenkins exposes no commit SHA for planexpo builds (no git `BuildData`, no
//! changesets, and the `deploy-preview` job is unused — the preview is deployed
//! by the `Deploy preview` stage of `build-and-test`). So instead of asking
//! Jenkins, we ask the **preview itself**: every preview serves a `/version`
//! endpoint whose first line is `commit <sha>` (a `git log -1` dump). We compare
//! that deployed SHA to the PR head (`headRefOid` from GitHub) and get three
//! actionable states:
//!
//! - **UP_TO_DATE** — preview reachable and serving the PR head commit.
//! - **STALE** — preview reachable but serving an older commit (périmée).
//! - **DOWN** — preview unreachable (env down / not deployed).
//! - **UNKNOWN** — reachable but we couldn't resolve a SHA to compare.
//!
//! Classification ([`classify`]) and parsing ([`parse_version_sha`]) are pure
//! and unit-tested. The PR head read shells out to `gh` like
//! `projects::pr_status`, so it runs inside `spawn_blocking` from async callers.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::platform::silent_command;

/// Preview is reachable and serving the current PR head commit.
pub const FRESH_UP_TO_DATE: &str = "UP_TO_DATE";
/// Preview is reachable but serving an older commit than the PR head.
pub const FRESH_STALE: &str = "STALE";
/// Preview is unreachable (env down or never deployed).
pub const FRESH_DOWN: &str = "DOWN";
/// Reachable, but a SHA to compare couldn't be resolved.
pub const FRESH_UNKNOWN: &str = "UNKNOWN";

/// How long to wait on the preview `/version` probe before calling it down.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Whether the live preview matches the PR head, surfaced to the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFreshness {
    /// `UP_TO_DATE` / `STALE` / `DOWN` / `UNKNOWN`.
    pub status: String,
    /// Commit the preview is actually serving (from its `/version` endpoint).
    pub preview_sha: Option<String>,
    /// Current PR head commit (`headRefOid`).
    pub pr_head_sha: Option<String>,
    /// How many commits the PR head is ahead of the preview (best-effort).
    pub behind_by: Option<u32>,
}

/// The preview `/version` URL for a PR (e.g. `https://3959.preview.example.com/version`).
fn preview_version_url(pr_id: &str) -> String {
    format!("https://{pr_id}.preview.example.com/version")
}

/// Parse the deployed commit SHA from a `/version` body.
///
/// The endpoint returns a `git log -1` dump whose first line is `commit <sha>`.
pub fn parse_version_sha(body: &str) -> Option<String> {
    let first = body.lines().next()?.trim();
    let sha = first.strip_prefix("commit ")?.trim();
    is_sha(sha).then(|| sha.to_string())
}

/// A plausible git SHA: 7–40 hex chars.
fn is_sha(value: &str) -> bool {
    let len = value.len();
    (7..=40).contains(&len) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Classify freshness from the probe result and the PR head SHA. Pure.
pub fn classify(
    reachable: bool,
    preview_sha: Option<&str>,
    pr_head_sha: Option<&str>,
    behind_by: Option<u32>,
) -> PreviewFreshness {
    let head = pr_head_sha.map(str::to_string);

    if !reachable {
        return PreviewFreshness {
            status: FRESH_DOWN.to_string(),
            preview_sha: None,
            pr_head_sha: head,
            behind_by: None,
        };
    }

    let preview = preview_sha.map(str::to_string);

    match (preview_sha, pr_head_sha) {
        (Some(p), Some(h)) if sha_matches(p, h) => PreviewFreshness {
            status: FRESH_UP_TO_DATE.to_string(),
            preview_sha: preview,
            pr_head_sha: head,
            behind_by: Some(0),
        },
        (Some(_), Some(_)) => PreviewFreshness {
            status: FRESH_STALE.to_string(),
            preview_sha: preview,
            pr_head_sha: head,
            behind_by,
        },
        _ => PreviewFreshness {
            status: FRESH_UNKNOWN.to_string(),
            preview_sha: preview,
            pr_head_sha: head,
            behind_by: None,
        },
    }
}

/// Equal as far as both are known — tolerant of short vs full SHAs.
fn sha_matches(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim(), b.trim());
    let n = a.len().min(b.len()).min(40);
    n >= 7 && a[..n].eq_ignore_ascii_case(&b[..n])
}

/// Resolve freshness for a PR's preview: probe `/version`, fetch the PR head,
/// compare, and (only when stale) count how many commits behind.
pub async fn resolve_freshness(
    repo_path: &str,
    pr_id: &str,
    pr_number: Option<u32>,
    gh_binary: PathBuf,
) -> PreviewFreshness {
    let (reachable, preview_sha) = probe_preview(pr_id).await;
    if !reachable {
        return classify(false, None, None, None);
    }

    // The PR head read + behind-count shell out to `gh` (blocking).
    let repo = repo_path.to_string();
    let probe_sha = preview_sha.clone();
    let (head, behind_by) = tokio::task::spawn_blocking(move || {
        let head = fetch_pr_head_sha(&repo, pr_number, &gh_binary);
        let behind = match (probe_sha.as_deref(), head.as_deref()) {
            (Some(p), Some(h)) if !sha_matches(p, h) => fetch_behind_by(&repo, p, h, &gh_binary),
            _ => None,
        };
        (head, behind)
    })
    .await
    .unwrap_or((None, None));

    classify(true, preview_sha.as_deref(), head.as_deref(), behind_by)
}

/// Probe the preview `/version` endpoint.
///
/// Returns `(reachable, deployed_sha)`. A connection error / timeout / non-2xx
/// means the preview is down. Preview envs are internal (`*.preview.example.com`) and
/// may use self-signed certs, so cert validation is relaxed for this probe only.
async fn probe_preview(pr_id: &str) -> (bool, Option<String>) {
    let client = match reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build()
    {
        Ok(c) => c,
        Err(_) => return (false, None),
    };

    // Only the first line (`commit <sha>`) is needed; ask for a small range.
    match client
        .get(preview_version_url(pr_id))
        .header("Range", "bytes=0-127")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.text().await.unwrap_or_default();
            (true, parse_version_sha(&body))
        }
        _ => (false, None),
    }
}

/// Fetch the PR head commit via `gh pr view <n> --json headRefOid`.
fn fetch_pr_head_sha(repo_path: &str, pr_number: Option<u32>, gh_binary: &Path) -> Option<String> {
    let pr_number = pr_number?;
    let output = silent_command(gh_binary)
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "headRefOid",
            "--jq",
            ".headRefOid",
        ])
        .current_dir(repo_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

/// Count how many commits `head` is ahead of `base` via the GitHub compare API.
///
/// `gh` resolves the `{owner}`/`{repo}` placeholders from the worktree's repo.
fn fetch_behind_by(repo_path: &str, base: &str, head: &str, gh_binary: &Path) -> Option<u32> {
    let path = format!("repos/{{owner}}/{{repo}}/compare/{base}...{head}");
    let output = silent_command(gh_binary)
        .args(["api", &path, "--jq", ".ahead_by"])
        .current_dir(repo_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA_A: &str = "9a54f3bafc2fa898b06a5fb0b48bae73af92963f";
    const SHA_B: &str = "ffffffffffffffffffffffffffffffffffffffff";

    #[test]
    fn parses_sha_from_version_dump() {
        // The real `/version` body is a `git log -1 --stat` dump.
        let body = "commit 9a54f3bafc2fa898b06a5fb0b48bae73af92963f\n\
                    Author: Nabil <nabil@example.com>\n\
                    Date:   Fri Jun 19 17:58:08 2026 +0200\n\n    Revert ...\n\nM\tfront/app.elm\n";
        assert_eq!(parse_version_sha(body).as_deref(), Some(SHA_A));
    }

    #[test]
    fn rejects_non_commit_first_line() {
        assert_eq!(parse_version_sha("<html>403 Forbidden</html>"), None);
        assert_eq!(parse_version_sha("commit not-a-sha"), None);
        assert_eq!(parse_version_sha(""), None);
    }

    #[test]
    fn up_to_date_when_shas_match() {
        let f = classify(true, Some(SHA_A), Some(SHA_A), None);
        assert_eq!(f.status, FRESH_UP_TO_DATE);
        assert_eq!(f.behind_by, Some(0));
        assert_eq!(f.preview_sha.as_deref(), Some(SHA_A));
    }

    #[test]
    fn up_to_date_tolerates_short_head() {
        // GitHub head given as an abbreviated SHA still matches the full preview SHA.
        let f = classify(true, Some(SHA_A), Some(&SHA_A[..10]), None);
        assert_eq!(f.status, FRESH_UP_TO_DATE);
    }

    #[test]
    fn stale_when_shas_differ() {
        let f = classify(true, Some(SHA_A), Some(SHA_B), Some(3));
        assert_eq!(f.status, FRESH_STALE);
        assert_eq!(f.preview_sha.as_deref(), Some(SHA_A));
        assert_eq!(f.pr_head_sha.as_deref(), Some(SHA_B));
        assert_eq!(f.behind_by, Some(3));
    }

    #[test]
    fn down_when_unreachable() {
        let f = classify(false, None, Some(SHA_A), None);
        assert_eq!(f.status, FRESH_DOWN);
        assert_eq!(f.preview_sha, None);
        // PR head is still surfaced for context.
        assert_eq!(f.pr_head_sha.as_deref(), Some(SHA_A));
    }

    #[test]
    fn unknown_when_a_sha_is_missing() {
        assert_eq!(
            classify(true, None, Some(SHA_A), None).status,
            FRESH_UNKNOWN
        );
        assert_eq!(
            classify(true, Some(SHA_A), None, None).status,
            FRESH_UNKNOWN
        );
    }
}
