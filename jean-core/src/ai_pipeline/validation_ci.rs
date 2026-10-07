//! Strict Planexpo CI proof: an unrelated green check is not a pipeline verdict.
use crate::jenkins::gh_checks::PrCheck;
use std::path::Path;

pub const REQUIRED_JENKINS_CONTEXT: &str = "Execution du job 'build-and-test'";

#[derive(Clone, Copy, PartialEq, Eq)]
enum CheckVerdict {
    Success,
    Failure,
    Pending,
    Unconfirmed,
    Ignored,
}

fn check_verdict(node: &serde_json::Value) -> CheckVerdict {
    use CheckVerdict::*;
    if let Some(state) = node.get("state").and_then(|value| value.as_str()) {
        return match state {
            "SUCCESS" => Success,
            "FAILURE" | "ERROR" => Failure,
            "PENDING" | "EXPECTED" => Pending,
            _ => Unconfirmed,
        };
    }
    match node.get("status").and_then(|value| value.as_str()) {
        Some("QUEUED" | "IN_PROGRESS" | "WAITING" | "PENDING" | "REQUESTED") => Pending,
        Some("COMPLETED") => match node.get("conclusion").and_then(|value| value.as_str()) {
            Some("SUCCESS") => Success,
            Some(
                "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
                | "STALE",
            ) => Failure,
            Some("NEUTRAL" | "SKIPPED") => Ignored,
            _ => Unconfirmed,
        },
        _ => Unconfirmed,
    }
}

/// The named Planexpo pipeline must positively report success. An unrelated
/// green check, a skipped required check, or an unknown status cannot stand in.
pub fn parse_validation_pr_check(json: &str, pr: u32) -> Result<PrCheck, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "Invalid validation CI JSON")?;
    if pr == 0 || value.get("number").and_then(|number| number.as_u64()) != Some(u64::from(pr)) {
        return Err("Validation CI response belongs to another or missing PR".into());
    }
    let head = value
        .get("headRefOid")
        .and_then(|value| value.as_str())
        .filter(|head| head.len() == 40 && head.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("Validation CI requires a full commit SHA")?;
    let nodes = value
        .get("statusCheckRollup")
        .and_then(|value| value.as_array())
        .ok_or("Validation CI rollup missing or malformed")?;
    let required: Vec<_> = nodes
        .iter()
        .filter(|node| {
            node.get("context").and_then(|value| value.as_str()) == Some(REQUIRED_JENKINS_CONTEXT)
                || node.get("name").and_then(|value| value.as_str())
                    == Some(REQUIRED_JENKINS_CONTEXT)
        })
        .map(check_verdict)
        .collect();
    let verdict = if required.is_empty() {
        None
    } else if nodes
        .iter()
        .any(|node| check_verdict(node) == CheckVerdict::Failure)
    {
        Some("FAILURE".into())
    } else if required
        .iter()
        .all(|status| *status == CheckVerdict::Success)
        && nodes.iter().all(|node| {
            matches!(
                check_verdict(node),
                CheckVerdict::Success | CheckVerdict::Ignored
            )
        })
    {
        Some("SUCCESS".into())
    } else {
        Some("BUILDING".into())
    };
    Ok(PrCheck {
        verdict,
        head_sha: Some(head.into()),
    })
}

/// Blocking read-only command; callers schedule it on spawn_blocking. No CLI
/// mutation, retries or credentials are logged here.
pub fn fetch_validation_pr_check(
    repo_path: &str,
    gh_binary: &Path,
    pr: u32,
) -> Result<PrCheck, String> {
    if pr == 0 {
        return Err("Invalid validation PR number".into());
    }
    let output = crate::platform::resolved_cli_command(gh_binary, Some(Path::new(repo_path)))
        .args([
            "pr",
            "view",
            &pr.to_string(),
            "--json",
            "number,headRefOid,statusCheckRollup",
        ])
        .output()
        .map_err(|_| "GitHub validation CI command could not start")?;
    if !output.status.success() {
        return Err(
            "GitHub validation CI unavailable; head and required pipeline not confirmed".into(),
        );
    }
    let json =
        std::str::from_utf8(&output.stdout).map_err(|_| "Invalid GitHub validation CI encoding")?;
    parse_validation_pr_check(json, pr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";
    fn fixture(nodes: Vec<Value>) -> String {
        json!({ "number": 42, "headRefOid": HEAD, "statusCheckRollup": nodes }).to_string()
    }
    fn required(state: &str) -> Value {
        json!({"__typename":"StatusContext", "context":REQUIRED_JENKINS_CONTEXT, "state":state})
    }
    fn check(name: &str, status: &str, conclusion: Option<&str>) -> Value {
        json!({"__typename":"CheckRun", "name":name, "status":status, "conclusion":conclusion})
    }
    #[test]
    fn unrelated_green_checks_never_validate_pipeline() {
        for nodes in [
            vec![],
            vec![check("lint", "COMPLETED", Some("SUCCESS"))],
            vec![check("CLA", "COMPLETED", Some("SUCCESS"))],
            vec![json!({"context":"Jenkins unrelated", "state":"SUCCESS"})],
            vec![json!({"context":format!("{REQUIRED_JENKINS_CONTEXT} extra"), "state":"SUCCESS"})],
        ] {
            let result = parse_validation_pr_check(&fixture(nodes), 42).unwrap();
            assert_eq!(result.verdict, None);
            assert_eq!(result.head_sha.as_deref(), Some(HEAD));
        }
    }
    #[test]
    fn exact_required_green_and_full_head_are_confirmed() {
        let result = parse_validation_pr_check(&fixture(vec![required("SUCCESS")]), 42).unwrap();
        assert_eq!(result.verdict.as_deref(), Some("SUCCESS"));
        assert_eq!(result.head_sha.as_deref(), Some(HEAD));
    }
    #[test]
    fn required_pending_neutral_unknown_are_not_green() {
        for node in [
            required("PENDING"),
            required("EXPECTED"),
            required("UNKNOWN"),
            required(""),
            check(REQUIRED_JENKINS_CONTEXT, "IN_PROGRESS", None),
            check(REQUIRED_JENKINS_CONTEXT, "COMPLETED", Some("NEUTRAL")),
            check(REQUIRED_JENKINS_CONTEXT, "COMPLETED", Some("SKIPPED")),
            check(REQUIRED_JENKINS_CONTEXT, "COMPLETED", Some("UNKNOWN")),
            check(REQUIRED_JENKINS_CONTEXT, "COMPLETED", None),
        ] {
            let result = parse_validation_pr_check(&fixture(vec![node]), 42).unwrap();
            assert!(result.verdict.is_none() || result.verdict.as_deref() == Some("BUILDING"));
        }
    }
    #[test]
    fn required_failure_and_other_checks_cannot_be_hidden_by_green() {
        for nodes in [
            vec![required("FAILURE")],
            vec![required("ERROR")],
            vec![
                required("SUCCESS"),
                check("lint", "COMPLETED", Some("FAILURE")),
            ],
            vec![
                required("SUCCESS"),
                check("lint", "COMPLETED", Some("CANCELLED")),
            ],
            vec![required("SUCCESS"), required("FAILURE")],
        ] {
            assert_eq!(
                parse_validation_pr_check(&fixture(nodes), 42)
                    .unwrap()
                    .verdict
                    .as_deref(),
                Some("FAILURE")
            );
        }
        assert_eq!(
            parse_validation_pr_check(
                &fixture(vec![
                    required("SUCCESS"),
                    check("lint", "IN_PROGRESS", None)
                ]),
                42
            )
            .unwrap()
            .verdict
            .as_deref(),
            Some("BUILDING")
        );
    }
    #[test]
    fn required_check_run_success_is_supported_exactly() {
        assert_eq!(
            parse_validation_pr_check(
                &fixture(vec![check(
                    REQUIRED_JENKINS_CONTEXT,
                    "COMPLETED",
                    Some("SUCCESS")
                )]),
                42
            )
            .unwrap()
            .verdict
            .as_deref(),
            Some("SUCCESS")
        );
    }
    #[test]
    fn malformed_identity_and_rollup_are_refused() {
        for value in [
            json!({}),
            json!([]),
            json!({"number":43,"headRefOid":HEAD,"statusCheckRollup":[]}),
            json!({"number":42,"headRefOid":"0123456","statusCheckRollup":[]}),
            json!({"number":42,"headRefOid":"z".repeat(40),"statusCheckRollup":[]}),
            json!({"number":42,"headRefOid":HEAD}),
            json!({"number":42,"headRefOid":HEAD,"statusCheckRollup":{}}),
        ] {
            assert!(parse_validation_pr_check(&value.to_string(), 42).is_err());
        }
        assert!(parse_validation_pr_check("not JSON", 42).is_err());
        assert!(parse_validation_pr_check(&fixture(vec![required("SUCCESS")]), 0).is_err());
    }
}
