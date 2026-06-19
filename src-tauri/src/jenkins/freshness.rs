//! Preview freshness: is the deployed `deploy-preview` up to date with the PR?
//!
//! The `deploy-preview` job checks out the PR's source branch, so the commit it
//! built (`JenkinsBuild.commit_sha`) is directly comparable to the PR's GitHub
//! head (`headRefOid`). When they differ, the live preview is stale.
//!
//! Classification is pure ([`compute_freshness`], unit-tested). The GitHub reads
//! ([`fetch_pr_head_sha`], [`fetch_behind_by`]) shell out to `gh` like
//! `projects::pr_status`, so they run inside `spawn_blocking` from async callers.

use std::path::Path;

use serde::Serialize;

use super::types::JenkinsBuild;
use crate::platform::silent_command;

/// Preview is built from the current PR head.
pub const FRESH_UP_TO_DATE: &str = "UP_TO_DATE";
/// Preview is built from an older commit than the PR head.
pub const FRESH_STALE: &str = "STALE";
/// A preview deploy is currently running.
pub const FRESH_BUILDING: &str = "BUILDING";
/// No `deploy-preview` build exists for this PR yet.
pub const FRESH_NO_PREVIEW: &str = "NO_PREVIEW";
/// Could not resolve one of the two SHAs to compare.
pub const FRESH_UNKNOWN: &str = "UNKNOWN";

/// Whether the live preview matches the PR head, surfaced to the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFreshness {
    /// `UP_TO_DATE` / `STALE` / `BUILDING` / `NO_PREVIEW` / `UNKNOWN`.
    pub status: String,
    /// Commit the latest `deploy-preview` build was built from.
    pub preview_sha: Option<String>,
    /// Current PR head commit (`headRefOid`).
    pub pr_head_sha: Option<String>,
    /// How many commits the PR head is ahead of the preview (best-effort).
    pub behind_by: Option<u32>,
}

/// Classify freshness from the preview build's commit vs the PR head SHA. Pure.
pub fn compute_freshness(
    preview: Option<&JenkinsBuild>,
    pr_head_sha: Option<&str>,
    behind_by: Option<u32>,
) -> PreviewFreshness {
    let head = pr_head_sha.map(str::to_string);

    let Some(preview) = preview else {
        return PreviewFreshness {
            status: FRESH_NO_PREVIEW.to_string(),
            preview_sha: None,
            pr_head_sha: head,
            behind_by: None,
        };
    };

    let preview_sha = preview.commit_sha.clone();

    if preview.building {
        return PreviewFreshness {
            status: FRESH_BUILDING.to_string(),
            preview_sha,
            pr_head_sha: head,
            behind_by: None,
        };
    }

    match (preview_sha.as_deref(), pr_head_sha) {
        (Some(p), Some(h)) if sha_matches(p, h) => PreviewFreshness {
            status: FRESH_UP_TO_DATE.to_string(),
            preview_sha,
            pr_head_sha: head,
            behind_by: Some(0),
        },
        (Some(_), Some(_)) => PreviewFreshness {
            status: FRESH_STALE.to_string(),
            preview_sha,
            pr_head_sha: head,
            behind_by,
        },
        _ => PreviewFreshness {
            status: FRESH_UNKNOWN.to_string(),
            preview_sha,
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

/// Resolve freshness for a worktree's preview: fetch the PR head, compare, and
/// (only when stale) count how many commits behind. Returns `None` when there is
/// no preview build or no PR to compare against — callers then skip the badge.
pub fn resolve_freshness(
    repo_path: &str,
    pr_number: Option<u32>,
    preview: Option<&JenkinsBuild>,
    gh_binary: &Path,
) -> Option<PreviewFreshness> {
    preview?;
    let pr_number = pr_number?;

    let head = fetch_pr_head_sha(repo_path, pr_number, gh_binary);
    let freshness = compute_freshness(preview, head.as_deref(), None);

    if freshness.status == FRESH_STALE {
        if let (Some(base), Some(head)) = (freshness.preview_sha.as_deref(), head.as_deref()) {
            let behind_by = fetch_behind_by(repo_path, base, head, gh_binary);
            return Some(PreviewFreshness {
                behind_by,
                ..freshness
            });
        }
    }
    Some(freshness)
}

/// Fetch the PR head commit via `gh pr view <n> --json headRefOid`.
fn fetch_pr_head_sha(repo_path: &str, pr_number: u32, gh_binary: &Path) -> Option<String> {
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

    fn preview(building: bool, sha: Option<&str>) -> JenkinsBuild {
        JenkinsBuild {
            number: 221,
            result: if building {
                None
            } else {
                Some("SUCCESS".into())
            },
            building,
            timestamp_ms: 0,
            duration_ms: 0,
            url: String::new(),
            pr_id: Some("3959".into()),
            branch: Some("feat".into()),
            commit_sha: sha.map(str::to_string),
        }
    }

    const SHA_A: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const SHA_B: &str = "ffffffffffffffffffffffffffffffffffffffff";

    #[test]
    fn up_to_date_when_shas_match() {
        let f = compute_freshness(Some(&preview(false, Some(SHA_A))), Some(SHA_A), None);
        assert_eq!(f.status, FRESH_UP_TO_DATE);
        assert_eq!(f.behind_by, Some(0));
    }

    #[test]
    fn up_to_date_tolerates_short_head() {
        // GitHub head given as an abbreviated SHA still matches the full preview SHA.
        let f = compute_freshness(Some(&preview(false, Some(SHA_A))), Some(&SHA_A[..10]), None);
        assert_eq!(f.status, FRESH_UP_TO_DATE);
    }

    #[test]
    fn stale_when_shas_differ() {
        let f = compute_freshness(Some(&preview(false, Some(SHA_A))), Some(SHA_B), Some(3));
        assert_eq!(f.status, FRESH_STALE);
        assert_eq!(f.preview_sha.as_deref(), Some(SHA_A));
        assert_eq!(f.pr_head_sha.as_deref(), Some(SHA_B));
        assert_eq!(f.behind_by, Some(3));
    }

    #[test]
    fn building_preview_reports_building() {
        let f = compute_freshness(Some(&preview(true, Some(SHA_A))), Some(SHA_B), None);
        assert_eq!(f.status, FRESH_BUILDING);
        assert_eq!(f.behind_by, None);
    }

    #[test]
    fn no_preview_build() {
        let f = compute_freshness(None, Some(SHA_A), None);
        assert_eq!(f.status, FRESH_NO_PREVIEW);
    }

    #[test]
    fn unknown_when_a_sha_is_missing() {
        assert_eq!(
            compute_freshness(Some(&preview(false, None)), Some(SHA_A), None).status,
            FRESH_UNKNOWN
        );
        assert_eq!(
            compute_freshness(Some(&preview(false, Some(SHA_A))), None, None).status,
            FRESH_UNKNOWN
        );
    }
}
