#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_push_requires_reviewed_clean_head_and_current_base() {
        let root = std::env::temp_dir().join(format!("publication-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let repo = root.to_str().unwrap();
        git(repo, &["init", "-b", "main"]).unwrap();
        git(repo, &["config", "user.name", "Test"]).unwrap();
        git(repo, &["config", "user.email", "test@example.invalid"]).unwrap();
        std::fs::write(root.join("file"), "base").unwrap();
        git(repo, &["add", "file"]).unwrap();
        git(repo, &["commit", "-m", "base"]).unwrap();
        let remote = root.join("remote.git");
        git(repo, &["init", "--bare", remote.to_str().unwrap()]).unwrap();
        // Bare fixture is outside the worktree to keep cleanliness meaningful.
        let remote_outside = root.with_extension("git");
        std::fs::rename(&remote, &remote_outside).unwrap();
        git(
            repo,
            &["remote", "add", "origin", remote_outside.to_str().unwrap()],
        )
        .unwrap();
        git(repo, &["push", "origin", "main"]).unwrap();
        git(repo, &["checkout", "-b", "feature"]).unwrap();
        let mut execution =
            ValidationExecution::new("p".into(), "w".into(), repo.into(), "t".into(), None);
        execution.original_branch = Some("feature".into());
        execution.publication_base_branch = Some("main".into());
        execution.head_commit = Some("wrong".into());
        assert!(sync_git(&execution).is_err());
        execution.head_commit = Some(git(repo, &["rev-parse", "HEAD"]).unwrap());
        std::fs::write(root.join("file"), "dirty").unwrap();
        assert!(sync_git(&execution).is_err());
        git(repo, &["restore", "file"]).unwrap();
        assert_eq!(
            sync_git(&execution).unwrap(),
            execution.head_commit.clone().unwrap()
        );
        // Remote base advancing independently must not permit a fresh branch publication.
        git(repo, &["checkout", "main"]).unwrap();
        std::fs::write(root.join("file"), "new base").unwrap();
        git(repo, &["add", "file"]).unwrap();
        git(repo, &["commit", "-m", "new base"]).unwrap();
        git(repo, &["push", "origin", "main"]).unwrap();
        git(repo, &["checkout", "feature"]).unwrap();
        git(repo, &["checkout", "-b", "fresh-feature"]).unwrap();
        execution.original_branch = Some("fresh-feature".into());
        assert!(sync_git(&execution).is_err());
        git(repo, &["checkout", "feature"]).unwrap();
        execution.original_branch = Some("other".into());
        assert!(sync_git(&execution).is_err());
        execution.original_branch = Some("feature".into());
        git(
            repo,
            &[
                "remote",
                "set-url",
                "origin",
                "/nonexistent/jean-publication-remote",
            ],
        )
        .unwrap();
        assert!(sync_git(&execution).is_err());
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(remote_outside).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn fake_cli_reconciles_creation_failure_without_duplicates_and_rejects_wrong_url() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let repo_path = root.join("repo");
        std::fs::create_dir(&repo_path).unwrap();
        let cwd = repo_path.to_str().unwrap();
        git(cwd, &["init", "-b", "feature"]).unwrap();
        git(cwd, &["config", "user.name", "Test"]).unwrap();
        git(cwd, &["config", "user.email", "test@example.invalid"]).unwrap();
        git(cwd, &["commit", "--allow-empty", "-m", "fixture"]).unwrap();
        let remote = root.join("remote.git");
        git(cwd, &["init", "--bare", remote.to_str().unwrap()]).unwrap();
        git(cwd, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        git(cwd, &["push", "origin", "feature"]).unwrap();
        let sha = git(cwd, &["rev-parse", "HEAD"]).unwrap();
        let pr = serde_json::json!({"number":4,"url":"https://github.com/o/r/pull/4","state":"OPEN","headRefName":"feature","baseRefName":"main","headRefOid":sha,"isDraft":false,"isCrossRepository":false,"assignees":[{"login":"me"}]});
        let state = root.join("state.json");
        let payload = root.join("payload.json");
        let calls = root.join("calls");
        let cli = root.join("fake-gh");
        std::fs::write(&state, "[]").unwrap();
        std::fs::write(&payload, serde_json::json!([pr.clone()]).to_string()).unwrap();
        std::fs::write(
            &cli,
            format!(
                r#"#!/bin/sh
printf '%s\n' "$*" >> '{}'
if [ "$2" = list ]; then cat '{}'; exit 0; fi
if [ "$2" = create ]; then cp '{}' '{}'; exit 1; fi
exit 2
"#,
                calls.display(),
                state.display(),
                payload.display(),
                state.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let publish = || {
            publish_pr(
                cwd,
                &cli,
                "o/r",
                "feature",
                "main",
                &sha,
                "Améliorer le devis",
                "abc",
                "me",
            )
        };
        assert_eq!(publish().unwrap().number, 4);
        assert_eq!(publish().unwrap().number, 4); // Interrupted run: existing PR, no duplicate.
        let log = std::fs::read_to_string(&calls).unwrap();
        assert_eq!(
            log.lines()
                .filter(|line| line.starts_with("pr create"))
                .count(),
            1
        );
        assert!(log.contains("--assignee me"));
        std::fs::write(
            &state,
            serde_json::json!([pr.clone(), pr.clone()]).to_string(),
        )
        .unwrap();
        assert!(publish().is_err());
        let mut invalid_url = pr;
        invalid_url["url"] = serde_json::json!("https://attacker.invalid/pull/4");
        std::fs::write(&state, serde_json::json!([invalid_url]).to_string()).unwrap();
        assert!(publish().is_err());
        assert_eq!(
            std::fs::read_to_string(&calls)
                .unwrap()
                .lines()
                .filter(|line| line.starts_with("pr create"))
                .count(),
            1
        );
    }
    #[test]
    fn refuses_distinct_or_multiple_push_targets_without_writing_either() {
        let directory = tempfile::tempdir().unwrap();
        let repo_path = directory.path().join("repo");
        std::fs::create_dir(&repo_path).unwrap();
        let cwd = repo_path.to_str().unwrap();
        git(cwd, &["init", "-b", "main"]).unwrap();
        git(cwd, &["config", "user.name", "Test"]).unwrap();
        git(cwd, &["config", "user.email", "test@example.invalid"]).unwrap();
        git(cwd, &["commit", "--allow-empty", "-m", "fixture"]).unwrap();
        let remote_a = directory.path().join("a.git");
        let remote_b = directory.path().join("b.git");
        for remote in [&remote_a, &remote_b] {
            git(cwd, &["init", "--bare", remote.to_str().unwrap()]).unwrap();
        }
        git(
            cwd,
            &["remote", "add", "origin", remote_a.to_str().unwrap()],
        )
        .unwrap();
        git(cwd, &["push", "origin", "main"]).unwrap();
        git(cwd, &["checkout", "-b", "feature"]).unwrap();
        let mut execution =
            ValidationExecution::new("p".into(), "w".into(), cwd.into(), "t".into(), None);
        execution.original_branch = Some("feature".into());
        execution.publication_base_branch = Some("main".into());
        execution.head_commit = Some(git(cwd, &["rev-parse", "HEAD"]).unwrap());
        execution.publication_remote_identity = Some(capture_remote_identity(cwd).unwrap());
        git(
            cwd,
            &["remote", "set-url", "origin", remote_b.to_str().unwrap()],
        )
        .unwrap();
        assert!(sync_git(&execution).is_err());
        assert!(git(
            remote_b.to_str().unwrap(),
            &["rev-parse", "--verify", "refs/heads/feature"]
        )
        .is_err());
        git(
            cwd,
            &["remote", "set-url", "origin", remote_a.to_str().unwrap()],
        )
        .unwrap();
        git(
            cwd,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                remote_b.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(sync_git(&execution).is_err());
        assert!(git(
            remote_b.to_str().unwrap(),
            &["rev-parse", "--verify", "refs/heads/feature"]
        )
        .is_err());
        assert!(git(
            remote_a.to_str().unwrap(),
            &["rev-parse", "--verify", "refs/heads/feature"]
        )
        .is_err());
        git(
            cwd,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                remote_a.to_str().unwrap(),
            ],
        )
        .unwrap();
        git(
            cwd,
            &[
                "remote",
                "set-url",
                "--add",
                "--push",
                "origin",
                remote_b.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(sync_git(&execution).is_err());
        assert!(git(
            remote_b.to_str().unwrap(),
            &["rev-parse", "--verify", "refs/heads/feature"]
        )
        .is_err());
    }
    #[test]
    fn rejects_ambiguous_and_wrong_bindings() {
        let pr = serde_json::json!({"number":4,"url":"https://github.com/o/r/pull/4","state":"OPEN","headRefName":"feature","baseRefName":"main","headRefOid":"abc","isDraft":false,"isCrossRepository":false,"assignees":[]});
        assert!(parse_prs(&pr.to_string(), "feature", "main", "abc", "me").is_err());
        let mut foreign = pr.clone();
        foreign["assignees"] = serde_json::json!([{"login":"other"}]);
        assert!(parse_prs(
            &serde_json::json!([foreign]).to_string(),
            "feature",
            "main",
            "abc",
            "me"
        )
        .is_err());
        let mut closed = pr.clone();
        closed["state"] = serde_json::json!("CLOSED");
        assert!(parse_prs(
            &serde_json::json!([closed]).to_string(),
            "feature",
            "main",
            "abc",
            "me"
        )
        .is_err());

        assert!(parse_prs(
            &serde_json::json!([pr.clone(), pr.clone()]).to_string(),
            "feature",
            "main",
            "abc",
            "me"
        )
        .is_err());
        assert!(parse_prs(
            &serde_json::json!([pr.clone()]).to_string(),
            "feature",
            "main",
            "other",
            "me"
        )
        .is_err());
        assert!(parse_prs(
            &serde_json::json!([pr]).to_string(),
            "feature",
            "main",
            "abc",
            "me"
        )
        .unwrap()
        .is_some());
    }
}

use super::validation_steps::{git, is_clean};
use super::validation_types::ValidationExecution;
use serde::{Deserialize, Serialize};
use std::path::Path;

// Remote URLs may embed credentials: never relay command stderr or store URLs.
fn private_git(path: &str, args: &[&str]) -> Result<String, String> {
    let output = crate::platform::silent_command("git")
        .args(args)
        .current_dir(path)
        .output()
        .map_err(|_| "Commande Git de publication inaccessible")?;
    if !output.status.success() {
        return Err("Commande Git de publication échouée".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn publication_remote(path: &str) -> Result<String, String> {
    let fetch = private_git(path, &["remote", "get-url", "--all", "origin"])?;
    let push = private_git(path, &["remote", "get-url", "--push", "--all", "origin"])?;
    if fetch.lines().count() != 1
        || push.lines().count() != 1
        || fetch.is_empty()
        || fetch != push
        || fetch.starts_with('-')
    {
        return Err("Une cible origin unique et identique pour fetch/push est requise".into());
    }
    Ok(fetch)
}

/// Persist only this fingerprint, never the potentially credential-bearing URL.
pub fn capture_remote_identity(path: &str) -> Result<String, String> {
    Ok(remote_identity(&publication_remote(path)?))
}

fn remote_identity(target: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(target.as_bytes()))
}

fn verify_publication_remote(path: &str, captured: &str) -> Result<(), String> {
    if publication_remote(path)? != captured {
        return Err("La cible origin a changé pendant la publication".into());
    }
    Ok(())
}

/// Backend-owned publication: never stage, commit, merge or force-push.
pub fn sync_git(execution: &ValidationExecution) -> Result<String, String> {
    let path = &execution.repository_path;
    let branch = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if execution.original_branch.as_deref() != Some(&branch) {
        return Err("Branche différente de la cible initiale ; push refusé".into());
    }
    git(path, &["check-ref-format", "--branch", &branch])?;
    // A failed fetch is not evidence that the remote branch is absent.
    let target = publication_remote(path)?;
    if execution
        .publication_remote_identity
        .as_ref()
        .is_some_and(|expected| expected != &remote_identity(&target))
    {
        return Err("La cible origin diffère de la cible initialement autorisée".into());
    }
    private_git(
        path,
        &[
            "fetch",
            "--prune",
            &target,
            "+refs/heads/*:refs/remotes/origin/*",
        ],
    )?;
    verify_publication_remote(path, &target)?;
    let remote = format!("refs/remotes/origin/{branch}");
    let exists = crate::platform::silent_command("git")
        .args(["show-ref", "--verify", "--quiet", &remote])
        .current_dir(path)
        .status()
        .map_err(|_| "Git inaccessible")?;
    let ancestor = if exists.success() {
        remote.clone()
    } else if exists.code() == Some(1) && execution.pr_number.is_none() {
        let base = execution
            .publication_base_branch
            .as_deref()
            .ok_or("Base de publication explicite manquante")?;
        git(path, &["check-ref-format", "--branch", base])?;
        let reference = format!("refs/remotes/origin/{base}");
        git(path, &["rev-parse", "--verify", &reference])?;
        reference
    } else {
        return Err("Branche distante introuvable ou vérification impossible".into());
    };
    let head = git(path, &["rev-parse", "HEAD"])?;
    if execution.head_commit.as_deref() != Some(&head) {
        return Err("Commit différent du commit reviewé ; push refusé".into());
    }
    let ancestry = crate::platform::silent_command("git")
        .args(["merge-base", "--is-ancestor", &ancestor, &head])
        .current_dir(path)
        .status()
        .map_err(|_| "Vérification de l'ascendance Git inaccessible")?;
    if !ancestry.success() {
        return Err(if ancestry.code() == Some(1) {
            if exists.success() {
                "La branche feature distante a divergé ; intégration puis nouvelle review requises"
            } else {
                "La base distante a avancé ; première publication refusée"
            }
        } else {
            "Impossible de vérifier l'ascendance distante ; publication refusée"
        }
        .into());
    }
    if !is_clean(execution)?
        || git(path, &["rev-parse", "HEAD"])? != head
        || git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])? != branch
    {
        return Err("Worktree, branche ou commit modifié après review ; push refusé".into());
    }
    if !exists.success() || git(path, &["rev-parse", &remote])? != head {
        verify_publication_remote(path, &target)?;
        private_git(
            path,
            &["push", &target, &format!("{head}:refs/heads/{branch}")],
        )?;
        verify_publication_remote(path, &target)?;
    }
    verify_publication_remote(path, &target)?;
    Ok(head)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishedPr {
    pub number: u32,
    pub url: String,
    pub head_sha: String,
    pub head_branch: String,
    pub base_branch: String,
}

/// Strict binding check shared by reconciliation and post-create verification.
pub fn parse_prs(
    json: &str,
    branch: &str,
    base: &str,
    sha: &str,
    login: &str,
) -> Result<Option<PublishedPr>, String> {
    let prs: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|_| "Réponse GitHub PR invalide")?;
    if prs.len() > 1 {
        return Err("Plusieurs PR correspondent ; choix manuel requis".into());
    }
    let Some(pr) = prs.first() else {
        return Ok(None);
    };
    if pr["state"] != "OPEN"
        || pr["headRefName"] != branch
        || pr["baseRefName"] != base
        || pr["headRefOid"] != sha
        || pr["isDraft"] != false
        || pr["isCrossRepository"].as_bool() != Some(false)
    {
        return Err("La PR ne correspond pas exactement à la publication".into());
    }
    let assignees = pr["assignees"].as_array().ok_or("Assignees PR invalides")?;
    if login.is_empty() || assignees.iter().any(|a| a["login"].as_str() != Some(login)) {
        return Err("PR assignée à un autre utilisateur ; publication refusée".into());
    }
    let number = pr["number"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or("Numéro PR invalide")?;
    let url = pr["url"]
        .as_str()
        .filter(|u| u.starts_with("https://"))
        .ok_or("URL PR invalide")?
        .to_string();
    Ok(Some(PublishedPr {
        number,
        url,
        head_sha: sha.into(),
        head_branch: branch.into(),
        base_branch: base.into(),
    }))
}

fn gh(path: &Path, cwd: &str, args: &[&str]) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("Chemin GitHub CLI résolu requis".into());
    }
    let output = crate::platform::resolved_cli_command(path, Some(Path::new(cwd)))
        .args(args)
        .output()
        .map_err(|_| "GitHub CLI inaccessible")?;
    if !output.status.success() {
        // Never relay stderr: remote credentials or private content may be present.
        return Err("Commande GitHub échouée ; aucune confirmation de publication".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Reconcile before creating, then read back exact bindings. No Git mutation here.
#[allow(clippy::too_many_arguments)]
pub fn publish_pr(
    cwd: &str,
    gh_path: &Path,
    repository: &str,
    branch: &str,
    base: &str,
    sha: &str,
    task_title: &str,
    task_id: &str,
    login: &str,
) -> Result<PublishedPr, String> {
    if repository.split('/').count() != 2
        || repository.starts_with('-')
        || repository.split('/').any(|part| {
            part.is_empty()
                || part
                    .chars()
                    .any(|c| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_' | '.'))
        })
    {
        return Err("Dépôt GitHub explicite invalide".into());
    }
    for name in [branch, base] {
        git(cwd, &["check-ref-format", "--branch", name])?;
    }
    let target = publication_remote(cwd)?;
    let remote_head = private_git(
        cwd,
        &[
            "ls-remote",
            "--exit-code",
            &target,
            &format!("refs/heads/{branch}"),
        ],
    )?;
    if remote_head.split_whitespace().next() != Some(sha) {
        return Err("Commit distant différent du commit reviewé ; création PR refusée".into());
    }
    verify_publication_remote(cwd, &target)?;
    let query = || {
        gh(gh_path, cwd, &["pr", "list", "--repo", repository,
        "--head", branch, "--base", base, "--state", "all", "--limit", "100",
        "--json", "number,url,state,headRefName,baseRefName,headRefOid,isDraft,isCrossRepository,assignees"])
    };
    let reconcile = || -> Result<Option<PublishedPr>, String> {
        verify_publication_remote(cwd, &target)?;
        let pr = parse_prs(&query()?, branch, base, sha, login)?;
        verify_publication_remote(cwd, &target)?;
        if pr.as_ref().is_some_and(|pr| {
            pr.url != format!("https://github.com/{repository}/pull/{}", pr.number)
        }) {
            return Err("URL PR différente du dépôt et numéro attendus".into());
        }
        Ok(pr)
    };
    if let Some(pr) = reconcile()? {
        return Ok(pr);
    }
    let title = task_title.lines().next().unwrap_or("").trim();
    let fallback = format!("Ticket {task_id}");
    let title = if title.is_empty() {
        fallback.as_str()
    } else {
        title
    };
    let body =
        format!("## Objectif\n\n{title}\n\nTicket ClickUp : https://app.clickup.com/t/{task_id}\n");
    // A failure may follow a successful remote create; reconcile rather than retry create.
    verify_publication_remote(cwd, &target)?;
    let created = gh(
        gh_path,
        cwd,
        &[
            "pr",
            "create",
            "--repo",
            repository,
            "--head",
            branch,
            "--base",
            base,
            "--title",
            title,
            "--body",
            &body,
            "--assignee",
            login,
        ],
    );
    if let Some(pr) = reconcile()? {
        return Ok(pr);
    }
    created?;
    Err("PR créée mais confirmation exacte indisponible ; réconciliation requise".into())
}

/// Durable integration intent contains object IDs and an origin fingerprint, never URLs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteIntegrationPlan {
    pub local_head: String,
    pub remote_head: String,
    pub branch: String,
    pub remote_identity: String,
    pub expected_tree: String,
}

fn integration_guard(
    execution: &ValidationExecution,
    head: &str,
    branch: &str,
) -> Result<(), String> {
    let path = &execution.repository_path;
    if execution.original_branch.as_deref() != Some(branch)
        || git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])? != branch
        || git(path, &["rev-parse", "HEAD"])? != head
        || !is_clean(execution)?
    {
        return Err("Branche, HEAD ou worktree modifié ; intégration distante refusée".into());
    }
    git(path, &["check-ref-format", "--branch", branch])?;
    // Never continue an unrelated interrupted operation.
    for name in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] {
        if git(path, &["rev-parse", "--verify", name]).is_ok() {
            return Err("Opération Git déjà en cours ; intégration refusée".into());
        }
    }
    for name in ["rebase-merge", "rebase-apply"] {
        let git_path = git(path, &["rev-parse", "--git-path", name])?;
        let operation = Path::new(path).join(git_path);
        if operation.exists() {
            return Err("Rebase déjà en cours ; intégration refusée".into());
        }
    }
    Ok(())
}

fn fetch_integration_head(path: &str, branch: &str, identity: &str) -> Result<String, String> {
    let target = publication_remote(path)?;
    if remote_identity(&target) != identity {
        return Err("La cible origin a changé ; intégration refusée".into());
    }
    let reference = format!("refs/heads/{branch}");
    // A private ref avoids FETCH_HEAD / origin tracking ref races with other fetches.
    let private_ref = format!("refs/jean/integration/{}", uuid::Uuid::new_v4());
    let refspec = format!("{reference}:{private_ref}");
    let hooks = tempfile::tempdir().map_err(|_| "Dossier de hooks inaccessible")?;
    let hooks_config = format!("core.hooksPath={}", hooks.path().display());
    let result = (|| {
        private_git(
            path,
            &[
                "-c",
                &hooks_config,
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                &target,
                &refspec,
            ],
        )?;
        verify_publication_remote(path, &target)?;
        git(
            path,
            &[
                "rev-parse",
                "--verify",
                &format!("{private_ref}^{{commit}}"),
            ],
        )
    })();
    let cleanup = private_git(
        path,
        &["-c", &hooks_config, "update-ref", "-d", &private_ref],
    );
    cleanup?;
    result
}

/// Prepare without changing the index or worktree. A clean merge is NOT a review.
pub fn prepare_remote_integration(
    execution: &ValidationExecution,
) -> Result<Option<RemoteIntegrationPlan>, String> {
    let path = &execution.repository_path;
    let head = execution
        .head_commit
        .as_deref()
        .ok_or("HEAD reviewé manquant")?;
    let branch = execution
        .original_branch
        .as_deref()
        .ok_or("Branche initiale manquante")?;
    integration_guard(execution, head, branch)?;
    let identity = capture_remote_identity(path)?;
    if execution
        .publication_remote_identity
        .as_ref()
        .is_some_and(|expected| expected != &identity)
    {
        return Err("La cible origin diffère de la cible autorisée".into());
    }
    let target = publication_remote(path)?;
    if remote_identity(&target) != identity {
        return Err("La cible origin a changé ; préparation refusée".into());
    }
    let reference = format!("refs/heads/{branch}");
    let advertised = private_git(path, &["ls-remote", "--heads", &target, &reference])?;
    verify_publication_remote(path, &target)?;
    if advertised.is_empty() {
        integration_guard(execution, head, branch)?;
        return if execution.pr_number.is_none() {
            Ok(None)
        } else {
            Err("Branche distante de la PR introuvable ; intégration refusée".into())
        };
    }
    let mut lines = advertised.lines();
    let fields: Vec<_> = lines
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .collect();
    if lines.next().is_some()
        || fields.len() != 2
        || fields[1] != reference
        || !matches!(fields[0].len(), 40 | 64)
        || !fields[0].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(
            "Réponse distante ambiguë ou référence inattendue ; intégration refusée".into(),
        );
    }
    let remote_head = fetch_integration_head(path, branch, &identity)?;
    if git(path, &["merge-base", "--is-ancestor", &remote_head, head]).is_ok() {
        integration_guard(execution, head, branch)?;
        return Ok(None);
    }
    let tree = git(path, &["merge-tree", "--write-tree", head, &remote_head]).map_err(|_| {
        "Conflit avec la branche feature distante ; index et worktree préservés".to_string()
    })?;
    let expected_tree = tree
        .lines()
        .next()
        .ok_or("Arbre de fusion absent")?
        .to_string();
    git(
        path,
        &["cat-file", "-e", &format!("{expected_tree}^{{tree}}")],
    )?;
    if let Some(baseline) = &execution.runtime_config_baseline {
        if git(path, &["rev-parse", &format!("{expected_tree}:jean.json")])? != baseline.head_blob {
            return Err("La fusion modifierait la configuration runtime protégée".into());
        }
    }
    integration_guard(execution, head, branch)?;
    Ok(Some(RemoteIntegrationPlan {
        local_head: head.into(),
        remote_head,
        branch: branch.into(),
        remote_identity: identity,
        expected_tree,
    }))
}

/// Confirm a pinned merge after completion or interruption, without publishing it.
pub fn verify_completed_integration(
    execution: &ValidationExecution,
    plan: &RemoteIntegrationPlan,
) -> Result<String, String> {
    let path = &execution.repository_path;
    if execution.head_commit.as_deref() != Some(&plan.local_head)
        || execution
            .publication_remote_identity
            .as_ref()
            .is_some_and(|identity| identity != &plan.remote_identity)
    {
        return Err("Intent de fusion différent de la cible autorisée".into());
    }
    let head = git(path, &["rev-parse", "HEAD"])?;
    integration_guard(execution, &head, &plan.branch)?;
    if capture_remote_identity(path)? != plan.remote_identity {
        return Err("La cible origin a changé".into());
    }
    let parents = git(path, &["show", "-s", "--format=%P", &head])?;
    if parents != format!("{} {}", plan.local_head, plan.remote_head)
        || git(path, &["rev-parse", "HEAD^{tree}"])? != plan.expected_tree
    {
        return Err("Le commit ne correspond pas à la fusion distante prévue".into());
    }
    Ok(head)
}

/// Execute only the persisted, pinned plan. Never autostash, reset or force-push.
pub fn execute_remote_integration(
    execution: &ValidationExecution,
    plan: &RemoteIntegrationPlan,
) -> Result<String, String> {
    let path = &execution.repository_path;
    if execution.head_commit.as_deref() != Some(&plan.local_head) {
        return Err("Le plan ne correspond pas au HEAD reviewé".into());
    }
    integration_guard(execution, &plan.local_head, &plan.branch)?;
    if fetch_integration_head(path, &plan.branch, &plan.remote_identity)? != plan.remote_head {
        return Err("La branche distante a changé depuis la préparation".into());
    }
    // Recompute to reject a corrupted intent and config changes affecting merge behavior.
    let fresh = prepare_remote_integration(execution)?
        .ok_or("Intégration devenue inutile ; plan refusé")?;
    if fresh.remote_head != plan.remote_head
        || fresh.expected_tree != plan.expected_tree
        || fresh.remote_identity != plan.remote_identity
    {
        return Err("Le plan de fusion a changé".into());
    }
    let hooks = tempfile::tempdir().map_err(|_| "Dossier de hooks inaccessible")?;
    let hooks_config = format!("core.hooksPath={}", hooks.path().display());
    private_git(
        path,
        &[
            "-c",
            &hooks_config,
            "-c",
            "merge.autoStash=false",
            "-c",
            "rerere.enabled=false",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "merge.verifySignatures=false",
            "merge",
            "--commit",
            "--no-squash",
            "--no-ff",
            "--no-edit",
            &plan.remote_head,
        ],
    )?;
    verify_completed_integration(execution, plan)
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, ValidationExecution, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("local");
        let bot = dir.path().join("bot");
        std::fs::create_dir(&repo).unwrap();
        let path = repo.to_str().unwrap();
        git(path, &["init", "-b", "main"]).unwrap();
        git(path, &["config", "user.name", "Test"]).unwrap();
        git(path, &["config", "user.email", "test@example.invalid"]).unwrap();
        std::fs::write(repo.join("base"), "base").unwrap();
        git(path, &["add", "."]).unwrap();
        git(path, &["commit", "-m", "base"]).unwrap();
        let remote = dir.path().join("remote.git");
        git(path, &["init", "--bare", remote.to_str().unwrap()]).unwrap();
        git(path, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        git(path, &["push", "origin", "main"]).unwrap();
        git(path, &["checkout", "-b", "feature"]).unwrap();
        git(path, &["push", "origin", "feature"]).unwrap();
        git(
            path,
            &[
                "clone",
                "-b",
                "feature",
                remote.to_str().unwrap(),
                bot.to_str().unwrap(),
            ],
        )
        .unwrap();
        let bot = bot.to_str().unwrap().to_string();
        git(&bot, &["config", "user.name", "Bot"]).unwrap();
        git(&bot, &["config", "user.email", "bot@example.invalid"]).unwrap();
        std::fs::write(repo.join("local"), "local").unwrap();
        git(path, &["add", "."]).unwrap();
        git(path, &["commit", "-m", "reviewed local"]).unwrap();
        let mut execution =
            ValidationExecution::new("p".into(), "w".into(), path.into(), "t".into(), None);
        execution.original_branch = Some("feature".into());
        execution.head_commit = Some(git(path, &["rev-parse", "HEAD"]).unwrap());
        execution.publication_remote_identity = Some(capture_remote_identity(path).unwrap());
        (dir, execution, bot)
    }
    #[test]
    fn integrates_bot_base_merge_without_publishing_and_refuses_changed_remote() {
        let (_dir, execution, bot) = fixture();
        git(&bot, &["checkout", "-b", "main", "origin/main"]).unwrap();
        std::fs::write(Path::new(&bot).join("base"), "new base").unwrap();
        git(&bot, &["add", "."]).unwrap();
        git(&bot, &["commit", "-m", "base advanced"]).unwrap();
        git(&bot, &["checkout", "feature"]).unwrap();
        git(&bot, &["merge", "--no-ff", "--no-edit", "main"]).unwrap();
        git(&bot, &["push", "origin", "feature"]).unwrap();
        let plan = prepare_remote_integration(&execution).unwrap().unwrap();
        let head = execute_remote_integration(&execution, &plan).unwrap();
        assert_ne!(head, plan.local_head);
        assert_eq!(
            verify_completed_integration(&execution, &plan).unwrap(),
            head
        );
        assert_eq!(
            fetch_integration_head(&execution.repository_path, "feature", &plan.remote_identity)
                .unwrap(),
            plan.remote_head
        );
        assert!(execute_remote_integration(&execution, &plan).is_err());
    }
    #[test]
    fn conflict_and_foreign_changes_preserve_head_index_and_files() {
        let (_dir, execution, bot) = fixture();
        std::fs::write(Path::new(&bot).join("local"), "conflicting").unwrap();
        git(&bot, &["add", "."]).unwrap();
        git(&bot, &["commit", "-m", "remote conflict"]).unwrap();
        git(&bot, &["push", "origin", "feature"]).unwrap();
        let path = &execution.repository_path;
        let tree = git(path, &["write-tree"]).unwrap();
        assert!(prepare_remote_integration(&execution).is_err());
        assert_eq!(
            git(path, &["rev-parse", "HEAD"]).unwrap(),
            execution.head_commit.clone().unwrap()
        );
        assert_eq!(git(path, &["write-tree"]).unwrap(), tree);
        assert_eq!(
            std::fs::read_to_string(Path::new(path).join("local")).unwrap(),
            "local"
        );
        std::fs::write(Path::new(path).join("foreign"), "preserve").unwrap();
        assert!(prepare_remote_integration(&execution).is_err());
        assert!(Path::new(path).join("foreign").exists());
    }
    #[test]
    fn refuses_remote_change_after_preparation() {
        let (_dir, execution, bot) = fixture();
        std::fs::write(Path::new(&bot).join("remote"), "remote").unwrap();
        git(&bot, &["add", "."]).unwrap();
        git(&bot, &["commit", "-m", "remote"]).unwrap();
        git(&bot, &["push", "origin", "feature"]).unwrap();
        let plan = prepare_remote_integration(&execution).unwrap().unwrap();
        git(&bot, &["commit", "--allow-empty", "-m", "changed"]).unwrap();
        git(&bot, &["push", "origin", "feature"]).unwrap();
        assert!(execute_remote_integration(&execution, &plan).is_err());
        assert_eq!(
            git(&execution.repository_path, &["rev-parse", "HEAD"]).unwrap(),
            plan.local_head
        );
    }
    #[test]
    fn ancestor_noop_and_branch_head_dirty_guards() {
        let (_dir, mut execution, _bot) = fixture();
        assert!(prepare_remote_integration(&execution).unwrap().is_none());
        execution.original_branch = Some("main".into());
        assert!(prepare_remote_integration(&execution).is_err());
        execution.original_branch = Some("feature".into());
        execution.head_commit = Some("wrong".into());
        assert!(prepare_remote_integration(&execution).is_err());
        execution.head_commit =
            Some(git(&execution.repository_path, &["rev-parse", "HEAD"]).unwrap());
        std::fs::write(
            Path::new(&execution.repository_path).join("foreign"),
            "foreign",
        )
        .unwrap();
        assert!(prepare_remote_integration(&execution).is_err());
    }
    #[test]
    fn protected_runtime_is_never_overwritten() {
        use sha2::{Digest, Sha256};
        let (_dir, mut execution, bot) = fixture();
        let path = &execution.repository_path;
        std::fs::write(Path::new(path).join("jean.json"), "tracked").unwrap();
        git(path, &["add", "jean.json"]).unwrap();
        git(path, &["commit", "-m", "tracked runtime"]).unwrap();
        git(path, &["push", "origin", "feature"]).unwrap();
        git(&bot, &["pull", "--ff-only"]).unwrap();
        std::fs::write(Path::new(&bot).join("remote"), "remote").unwrap();
        git(&bot, &["add", "."]).unwrap();
        git(&bot, &["commit", "-m", "remote advance"]).unwrap();
        git(&bot, &["push", "origin", "feature"]).unwrap();
        execution.head_commit = Some(git(path, &["rev-parse", "HEAD"]).unwrap());
        execution.runtime_config_baseline =
            Some(super::super::runtime_config::RuntimeConfigBaseline {
                working_sha256: format!("{:x}", Sha256::digest(b"local runtime")),
                head_blob: git(path, &["rev-parse", "HEAD:jean.json"]).unwrap(),
            });
        std::fs::write(Path::new(path).join("jean.json"), "local runtime").unwrap();
        let plan = prepare_remote_integration(&execution).unwrap().unwrap();
        execute_remote_integration(&execution, &plan).unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(path).join("jean.json")).unwrap(),
            "local runtime"
        );
    }
    #[test]
    fn missing_first_publication_branch_is_not_created_and_pr_deletion_is_refused() {
        let (_dir, mut execution, _bot) = fixture();
        let path = execution.repository_path.clone();
        git(&path, &["push", "origin", "--delete", "feature"]).unwrap();
        assert!(prepare_remote_integration(&execution).unwrap().is_none());
        let target = publication_remote(&path).unwrap();
        assert!(private_git(
            &path,
            &["ls-remote", "--heads", &target, "refs/heads/feature"]
        )
        .unwrap()
        .is_empty());
        execution.pr_number = Some(4);
        assert!(prepare_remote_integration(&execution).is_err());
        execution.pr_number = None;
        git(
            &path,
            &[
                "remote",
                "set-url",
                "origin",
                "/nonexistent/jean-integration-remote",
            ],
        )
        .unwrap();
        execution.publication_remote_identity = Some(capture_remote_identity(&path).unwrap());
        assert!(prepare_remote_integration(&execution).is_err());
        assert_eq!(
            git(&path, &["rev-parse", "HEAD"]).unwrap(),
            execution.head_commit.unwrap()
        );
    }
}
