//! GitHub commit-status fallback for the CI verdict.
//!
//! Jenkins keeps a *very* short build history on a busy controller (Planexpo
//! retains ~27 pipeline builds ≈ 16 h — asking for 300 still returns 27, the
//! rest are physically rotated out). So [`super::parse::find_build_for_pr`]
//! finds nothing for any PR that was built the day before, and the worktree row
//! ends up with `overall_status = UNKNOWN` and renders *nothing* — which reads
//! as "the feature is broken" rather than "Jenkins forgot".
//!
//! It also covers PRs routed to the legacy pipeline, which produce no build of
//! the unified job at all.
//!
//! The verdict itself is not lost: the ghprb trigger writes it to the PR head as
//! a GitHub **commit status**, which GitHub keeps forever. One
//! `gh pr list --json number,headRefOid,statusCheckRollup` call per project
//! recovers it for every open PR at once — cheaper than the per-worktree
//! `gh pr view` the freshness probe used to make, and it returns `headRefOid`
//! too, so that probe can reuse it instead of shelling out again.
//!
//! Parsing ([`parse_pr_checks`]) is pure and unit-tested; the `gh` call shells
//! out like `projects::pr_status`, so callers run it inside `spawn_blocking`.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use super::parse::{STATUS_BUILDING, STATUS_FAILURE, STATUS_SUCCESS};
use crate::platform::silent_command;

/// How many open PRs to ask GitHub about in one call.
const PR_LIST_LIMIT: &str = "200";

/// What GitHub knows about one open PR: the rolled-up CI verdict and the head
/// commit. Both are best-effort — either can be `None`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PrCheck {
    /// `SUCCESS` / `FAILURE` / `BUILDING`, or `None` when no check reported yet.
    pub verdict: Option<String>,
    /// `headRefOid` — the PR head commit, reused by the preview freshness probe.
    pub head_sha: Option<String>,
}

/// Map of PR number → what GitHub reports for it.
pub type PrChecks = HashMap<u32, PrCheck>;

/// Roll a `statusCheckRollup` array up into a single verdict.
///
/// Handles both node shapes `gh` returns: legacy `StatusContext` (`state`, what
/// ghprb writes) and `CheckRun` (`status` + `conclusion`, GitHub Actions).
/// Aggregation is worst-wins: any failure → `FAILURE`, else any in-flight →
/// `BUILDING`, else `SUCCESS` if at least one check reported.
fn roll_up(rollup: &Value) -> Option<String> {
    let nodes = rollup.as_array()?;
    let mut any_success = false;
    let mut any_pending = false;

    for node in nodes {
        match node_verdict(node) {
            Some(v) if v == STATUS_FAILURE => return Some(STATUS_FAILURE.to_string()),
            Some(v) if v == STATUS_BUILDING => any_pending = true,
            Some(_) => any_success = true,
            None => {}
        }
    }

    if any_pending {
        return Some(STATUS_BUILDING.to_string());
    }
    any_success.then(|| STATUS_SUCCESS.to_string())
}

/// Verdict of a single rollup node, or `None` when it carries no usable state.
fn node_verdict(node: &Value) -> Option<&'static str> {
    // CheckRun: in flight until `status == COMPLETED`, then judged on `conclusion`.
    if let Some(status) = node.get("status").and_then(Value::as_str) {
        if !status.eq_ignore_ascii_case("COMPLETED") {
            return Some(STATUS_BUILDING);
        }
        return match node.get("conclusion").and_then(Value::as_str) {
            Some(c) if c.eq_ignore_ascii_case("SUCCESS") => Some(STATUS_SUCCESS),
            // Neutral/skipped checks are not failures — they just don't vote.
            Some(c) if c.eq_ignore_ascii_case("NEUTRAL") || c.eq_ignore_ascii_case("SKIPPED") => {
                None
            }
            Some(_) => Some(STATUS_FAILURE),
            None => Some(STATUS_BUILDING),
        };
    }

    // StatusContext: a plain commit status (what the ghprb trigger writes).
    match node.get("state").and_then(Value::as_str) {
        Some(s) if s.eq_ignore_ascii_case("SUCCESS") => Some(STATUS_SUCCESS),
        Some(s) if s.eq_ignore_ascii_case("PENDING") || s.eq_ignore_ascii_case("EXPECTED") => {
            Some(STATUS_BUILDING)
        }
        Some(_) => Some(STATUS_FAILURE),
        None => None,
    }
}

/// Parse the `gh pr list --json number,headRefOid,statusCheckRollup` output.
///
/// Unknown/misshapen entries are skipped rather than failing the whole map —
/// this is a best-effort fallback, never a hard dependency.
pub fn parse_pr_checks(json: &str) -> PrChecks {
    let Ok(Value::Array(prs)) = serde_json::from_str::<Value>(json) else {
        return PrChecks::new();
    };

    prs.iter()
        .filter_map(|pr| {
            let number = u32::try_from(pr.get("number").and_then(Value::as_u64)?).ok()?;
            let check = PrCheck {
                verdict: pr.get("statusCheckRollup").and_then(roll_up),
                head_sha: pr
                    .get("headRefOid")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
            };
            Some((number, check))
        })
        .collect()
}

/// Fetch the CI verdict + head commit of every open PR of a repo, in one `gh`
/// call. Blocking (spawns a subprocess) — call from `spawn_blocking`.
///
/// Returns an empty map on any failure: the fallback degrades to today's
/// behaviour instead of breaking the Jenkins status.
pub fn fetch_pr_checks(repo_path: &str, gh_binary: &Path) -> PrChecks {
    let output = silent_command(gh_binary)
        .args([
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            PR_LIST_LIMIT,
            "--json",
            "number,headRefOid,statusCheckRollup",
        ])
        .current_dir(repo_path)
        .output();

    let Ok(output) = output else {
        log::debug!("Jenkins: `gh pr list` failed to spawn in {repo_path}");
        return PrChecks::new();
    };
    if !output.status.success() {
        log::debug!(
            "Jenkins: `gh pr list` failed in {repo_path}: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(200)
                .collect::<String>()
        );
        return PrChecks::new();
    }

    parse_pr_checks(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shape captured from the real `gh pr list` output on the Planexpo repo.
    /// The context still names the legacy job: it comes from the ghprb *entry*
    /// job, which the unified pipeline runs behind and which never got renamed.
    const FIXTURE: &str = r#"[
      {"number":4151,"headRefOid":"b2babcb0dc1c38b39b5d311d8841876006b65c59",
       "statusCheckRollup":[{"__typename":"StatusContext","context":"Execution du job 'build-and-test'",
         "state":"PENDING","targetUrl":"http://jenkins.example/job/x/1/"}]},
      {"number":4150,"headRefOid":"533c6e0f4c19c5573eeb1c6f2266d9c0176568a8",
       "statusCheckRollup":[{"__typename":"StatusContext","context":"Execution du job 'build-and-test'",
         "state":"SUCCESS","targetUrl":"http://jenkins.example/job/x/2/"}]},
      {"number":4148,"headRefOid":"e655969571ecc186d91817940753b76cb8e9f32f",
       "statusCheckRollup":[{"__typename":"StatusContext","state":"FAILURE"}]},
      {"number":4053,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
       "statusCheckRollup":[]}
    ]"#;

    #[test]
    fn maps_each_pr_to_its_verdict_and_head() {
        let checks = parse_pr_checks(FIXTURE);
        assert_eq!(checks.len(), 4);

        assert_eq!(checks[&4151].verdict.as_deref(), Some(STATUS_BUILDING));
        assert_eq!(checks[&4150].verdict.as_deref(), Some(STATUS_SUCCESS));
        assert_eq!(checks[&4148].verdict.as_deref(), Some(STATUS_FAILURE));
        assert_eq!(
            checks[&4150].head_sha.as_deref(),
            Some("533c6e0f4c19c5573eeb1c6f2266d9c0176568a8")
        );
    }

    #[test]
    fn pr_with_no_reported_check_has_no_verdict() {
        // An empty rollup must stay `None` — not a silent green.
        let checks = parse_pr_checks(FIXTURE);
        assert_eq!(checks[&4053].verdict, None);
        assert!(checks[&4053].head_sha.is_some());
    }

    #[test]
    fn failure_wins_over_pending_and_success() {
        let json = r#"[{"number":1,"headRefOid":"abc1234","statusCheckRollup":[
            {"state":"SUCCESS"},{"state":"PENDING"},{"state":"ERROR"}]}]"#;
        assert_eq!(
            parse_pr_checks(json)[&1].verdict.as_deref(),
            Some(STATUS_FAILURE)
        );
    }

    #[test]
    fn pending_wins_over_success() {
        let json = r#"[{"number":1,"headRefOid":"abc1234","statusCheckRollup":[
            {"state":"SUCCESS"},{"state":"PENDING"}]}]"#;
        assert_eq!(
            parse_pr_checks(json)[&1].verdict.as_deref(),
            Some(STATUS_BUILDING)
        );
    }

    #[test]
    fn handles_github_actions_check_runs() {
        let json = r#"[
          {"number":1,"headRefOid":"abc1234","statusCheckRollup":[
            {"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"SUCCESS"}]},
          {"number":2,"headRefOid":"def5678","statusCheckRollup":[
            {"__typename":"CheckRun","name":"test","status":"IN_PROGRESS","conclusion":null}]},
          {"number":3,"headRefOid":"aaa9999","statusCheckRollup":[
            {"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"FAILURE"}]},
          {"number":4,"headRefOid":"bbb0000","statusCheckRollup":[
            {"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"SKIPPED"}]}
        ]"#;
        let checks = parse_pr_checks(json);
        assert_eq!(checks[&1].verdict.as_deref(), Some(STATUS_SUCCESS));
        assert_eq!(checks[&2].verdict.as_deref(), Some(STATUS_BUILDING));
        assert_eq!(checks[&3].verdict.as_deref(), Some(STATUS_FAILURE));
        // A skipped check alone doesn't vote → no verdict at all.
        assert_eq!(checks[&4].verdict, None);
    }

    #[test]
    fn malformed_output_degrades_to_an_empty_map() {
        assert!(parse_pr_checks("").is_empty());
        assert!(parse_pr_checks("not json").is_empty());
        assert!(parse_pr_checks("{}").is_empty());
        // Entries without a number are skipped, the rest survive.
        let mixed =
            r#"[{"headRefOid":"abc1234"},{"number":7,"statusCheckRollup":[{"state":"SUCCESS"}]}]"#;
        let checks = parse_pr_checks(mixed);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[&7].verdict.as_deref(), Some(STATUS_SUCCESS));
    }
}
