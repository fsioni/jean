//! Inclusion, not equality: a deployed merge commit can contain the PR head.
use crate::platform::silent_command;
use serde::{Deserialize, Serialize};
use std::path::Path;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewInclusion {
    Included,
    NotIncluded,
    Unknown,
}
pub fn preview_url(pr_number: u32) -> Result<String, String> {
    if pr_number == 0 {
        return Err("Invalid PR number".into());
    }
    Ok(format!("https://{pr_number}.pr.planexpo/version"))
}
/// Missing objects and shallow ancestry must never be mistaken for stale deployment.
pub fn verify_inclusion(repository: &Path, expected: &str, deployed: &str) -> PreviewInclusion {
    fn sha(value: &str) -> bool {
        (7..=40).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
    }
    if !sha(expected) || !sha(deployed) {
        return PreviewInclusion::Unknown;
    }
    for commit in [expected, deployed] {
        let revision = format!("{commit}^{{commit}}");
        if !silent_command("git")
            .args(["rev-parse", "--verify", "--end-of-options", &revision])
            .current_dir(repository)
            .output()
            .is_ok_and(|o| o.status.success())
        {
            return PreviewInclusion::Unknown;
        }
    }
    let output = match silent_command("git")
        .args(["merge-base", "--is-ancestor", expected, deployed])
        .current_dir(repository)
        .output()
    {
        Ok(o) => o,
        Err(_) => return PreviewInclusion::Unknown,
    };
    match output.status.code() {
        Some(0) => PreviewInclusion::Included,
        Some(1) => {
            let complete = silent_command("git")
                .args(["rev-parse", "--is-shallow-repository"])
                .current_dir(repository)
                .output()
                .is_ok_and(|o| {
                    o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "false"
                });
            if complete {
                PreviewInclusion::NotIncluded
            } else {
                PreviewInclusion::Unknown
            }
        }
        _ => PreviewInclusion::Unknown,
    }
}
pub async fn fetch_preview_commit(pr_number: u32) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(preview_url(pr_number)?)
        .send()
        .await
        .map_err(|e| format!("Preview version unavailable: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Preview version HTTP {} (redirects are not authorized)",
            response.status()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 65536 {
            return Err("Preview version response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "Invalid preview version encoding")?;
    crate::jenkins::freshness::parse_version_sha(text)
        .ok_or_else(|| "Preview version non confirmée: unsupported response".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_objects_are_unknown() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            verify_inclusion(dir.path(), &"a".repeat(40), &"b".repeat(40)),
            PreviewInclusion::Unknown
        );
    }
    #[test]
    fn differing_shas_with_ancestry_are_included_and_divergence_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = silent_command("git")
                .args(args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Validation test"]);
        git(&["config", "user.email", "validation@example.invalid"]);
        git(&["commit", "--allow-empty", "-m", "base"]);
        let base = git(&["rev-parse", "HEAD"]);
        git(&["commit", "--allow-empty", "-m", "PR"]);
        let head = git(&["rev-parse", "HEAD"]);
        git(&["commit", "--allow-empty", "-m", "deploy"]);
        let deployed = git(&["rev-parse", "HEAD"]);
        assert_ne!(head, deployed);
        assert_eq!(
            verify_inclusion(dir.path(), &head, &deployed),
            PreviewInclusion::Included
        );
        git(&["checkout", "--detach", &base]);
        git(&["commit", "--allow-empty", "-m", "other"]);
        let other = git(&["rev-parse", "HEAD"]);
        assert_eq!(
            verify_inclusion(dir.path(), &head, &other),
            PreviewInclusion::NotIncluded
        );
    }
    #[test]
    fn host_cannot_be_injected() {
        assert_eq!(preview_url(42).unwrap(), "https://42.pr.planexpo/version");
        assert!(preview_url(0).is_err());
    }
}
