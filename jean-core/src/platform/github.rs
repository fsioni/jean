use std::path::Path;
use std::process::Command;

use super::{resolved_cli_command, silent_command};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GithubAccountSource {
    LocalGitConfig,
    ExplicitRepoOwner,
    GlobalGitConfig,
    ActiveGhAccount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubIdentity {
    pub account: String,
    pub repo: Option<String>,
    pub source: GithubAccountSource,
}

fn git_config(cwd: &Path, scope: &str) -> Option<String> {
    let output = silent_command("git")
        .args(["config", scope, "--get", "github.account"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

pub fn select_github_account(
    cwd: &Path,
    repo_hint: Option<&str>,
    global_account: Option<&str>,
) -> Result<GithubIdentity, String> {
    let repo = repo_hint.map(str::to_string);
    if let Some(account) = git_config(cwd, "--local") {
        return Ok(GithubIdentity {
            account,
            repo,
            source: GithubAccountSource::LocalGitConfig,
        });
    }
    if let Some(account) = repo_hint
        .and_then(|slug| slug.split_once('/'))
        .map(|(owner, _)| owner.trim())
        .filter(|owner| !owner.is_empty())
    {
        return Ok(GithubIdentity {
            account: account.to_string(),
            repo,
            source: GithubAccountSource::ExplicitRepoOwner,
        });
    }
    let account = global_account
        .map(str::to_string)
        .or_else(|| git_config(cwd, "--global"))
        .ok_or_else(|| "No GitHub account configured (github.account)".to_string())?;
    Ok(GithubIdentity {
        account,
        repo,
        source: GithubAccountSource::GlobalGitConfig,
    })
}

fn token_for_account(gh: &Path, cwd: &Path, account: &str) -> Option<String> {
    let mut command = resolved_cli_command(gh, Some(cwd));
    command
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .args([
            "auth",
            "token",
            "--hostname",
            "github.com",
            "--user",
            account,
        ]);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

fn active_gh_account(gh: &Path, cwd: &Path) -> Option<String> {
    let mut command = resolved_cli_command(gh, Some(cwd));
    command
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .args(["api", "user", "--jq", ".login"]);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let account = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!account.is_empty()).then_some(account)
}

/// Resolve an authenticated GitHub identity for a repository.
///
/// A repository owner may be an organization rather than a login. Prefer the
/// repository-specific selection when it has a token, then fall back to gh's
/// active authenticated account instead of manufacturing an invalid token.
pub fn resolve_github_identity(
    gh: &Path,
    cwd: &Path,
    repo_hint: Option<&str>,
) -> Result<GithubIdentity, String> {
    if let Ok(identity) = select_github_account(cwd, repo_hint, None) {
        if token_for_account(gh, cwd, &identity.account).is_some() {
            return Ok(identity);
        }
    }

    let account = active_gh_account(gh, cwd)
        .ok_or_else(|| "No authenticated GitHub CLI account available".to_string())?;
    Ok(GithubIdentity {
        account,
        repo: repo_hint.map(str::to_string),
        source: GithubAccountSource::ActiveGhAccount,
    })
}

/// Build a repository-scoped `gh` command without changing gh's globally active account.
pub fn resolved_gh_command(gh: &Path, cwd: &Path, repo_hint: Option<&str>) -> Command {
    let mut command = resolved_cli_command(gh, Some(cwd));
    if let Ok(identity) = resolve_github_identity(gh, cwd, repo_hint) {
        command.env("JEAN_GITHUB_ACCOUNT", &identity.account);
        if let Some(token) = token_for_account(gh, cwd, &identity.account) {
            command.env("GH_TOKEN", token).env_remove("GITHUB_TOKEN");
        } else {
            // Force an authentication failure instead of silently using gh's
            // globally active account when the repository account has no token.
            command
                .env("GH_TOKEN", "jean-missing-token-for-selected-account")
                .env_remove("GITHUB_TOKEN");
        }
    }
    command
}

pub fn github_access_error(account: &str, repo: Option<&str>, stderr: &str) -> String {
    let target = repo.unwrap_or("repository from current checkout");
    let safe_detail = stderr
        .split_whitespace()
        .filter(|part| {
            let lower = part.to_ascii_lowercase();
            !lower.contains("token") && !lower.starts_with("ghp_") && !lower.starts_with("gho_")
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("GitHub access failed using account '{account}' for '{target}': {safe_detail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(path: &std::path::Path, account: Option<&str>) {
        std::fs::create_dir_all(path).unwrap();
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(path)
            .status()
            .unwrap();
        if let Some(account) = account {
            std::process::Command::new("git")
                .args(["config", "--local", "github.account", account])
                .current_dir(path)
                .status()
                .unwrap();
        }
    }

    #[test]
    fn local_account_wins_regardless_of_path_or_process_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("Developer/Spottt/jean");
        init_repo(&repo, Some("fsioni"));

        let selected =
            select_github_account(&repo, Some("Spottt/planexpo"), Some("global-user")).unwrap();

        assert_eq!(selected.account, "fsioni");
        assert_eq!(selected.source, GithubAccountSource::LocalGitConfig);
    }

    #[test]
    fn professional_repository_uses_its_local_account() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("planexpo");
        init_repo(&repo, Some("fares-spottt"));

        let selected =
            select_github_account(&repo, Some("Spottt/planexpo"), Some("fsioni")).unwrap();

        assert_eq!(selected.account, "fares-spottt");
        assert_eq!(selected.repo.as_deref(), Some("Spottt/planexpo"));
    }

    #[test]
    fn explicit_repo_owner_precedes_global_account() {
        let temp = tempfile::tempdir().unwrap();
        init_repo(temp.path(), None);

        let selected =
            select_github_account(temp.path(), Some("Spottt/planexpo"), Some("fsioni")).unwrap();

        assert_eq!(selected.account, "Spottt");
        assert_eq!(selected.repo.as_deref(), Some("Spottt/planexpo"));
        assert_eq!(selected.source, GithubAccountSource::ExplicitRepoOwner);
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_active_gh_account_when_repo_owner_is_an_organization() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        init_repo(temp.path(), None);
        let gh = temp.path().join("gh");
        std::fs::write(
            &gh,
            r#"#!/bin/sh
if [ "$1 $2" = "auth token" ]; then
  case " $* " in
    *" --user Spottt "*) exit 1 ;;
    *" --user fares-spottt "*) echo active-token; exit 0 ;;
  esac
fi
if [ "$1 $2 $3" = "api user --jq" ]; then
  echo fares-spottt
  exit 0
fi
exit 1
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&gh).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&gh, permissions).unwrap();

        let identity = resolve_github_identity(&gh, temp.path(), Some("Spottt/planexpo"))
            .expect("the active authenticated user should be used as fallback");

        assert_eq!(identity.account, "fares-spottt");
        assert_eq!(identity.source, GithubAccountSource::ActiveGhAccount);
    }

    #[test]
    fn sanitizes_errors_without_leaking_tokens() {
        let message = github_access_error(
            "fares-spottt",
            Some("Spottt/planexpo"),
            "failure token=ghp_super_secret GH_TOKEN=another_secret",
        );

        assert!(message.contains("fares-spottt"));
        assert!(message.contains("Spottt/planexpo"));
        assert!(!message.contains("ghp_super_secret"));
        assert!(!message.contains("another_secret"));
    }
}
