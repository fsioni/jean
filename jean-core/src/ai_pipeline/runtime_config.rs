//! Narrow provenance exception for the runtime configuration copied by worktree setup.
use super::validation_steps::git;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeConfigBaseline {
    pub working_sha256: String,
    pub head_blob: String,
}

fn bytes(repo: &str) -> Result<Vec<u8>, String> {
    fs::read(Path::new(repo).join("jean.json"))
        .map_err(|e| format!("Configuration runtime inaccessible : {e}"))
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn cached_config(repo: &str) -> Result<String, String> {
    git(
        repo,
        &["diff", "--cached", "--name-only", "--", "jean.json"],
    )
}

pub fn capture(
    repository_path: &str,
    project_path: &str,
) -> Result<Option<RuntimeConfigBaseline>, String> {
    let repository = fs::canonicalize(repository_path).map_err(|e| e.to_string())?;
    let project = fs::canonicalize(project_path).map_err(|e| e.to_string())?;
    if repository == project
        || git(
            repository_path,
            &["diff", "--name-only", "--diff-filter=M", "--", "jean.json"],
        )? != "jean.json"
        || !cached_config(repository_path)?.is_empty()
    {
        return Ok(None);
    }
    let working = bytes(repository_path)?;
    if working != bytes(project_path)? {
        return Ok(None);
    }
    let Ok(config) = serde_json::from_slice::<serde_json::Value>(&working) else {
        return Ok(None);
    };
    let Some(setup) = config
        .pointer("/scripts/setup")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(None);
    };
    // Intentionally accept only the documented copy command, not shell strings
    // that merely mention it (echo, comments, conditional or unrelated commands).
    let Some(tail) = setup
        .trim()
        .strip_prefix("cp \"$JEAN_ROOT_PATH/jean.json\" .")
    else {
        return Ok(None);
    };
    if !tail.trim().is_empty() && !tail.trim_start().starts_with("&&") {
        return Ok(None);
    }
    Ok(Some(RuntimeConfigBaseline {
        working_sha256: hash(&working),
        head_blob: git(repository_path, &["rev-parse", "HEAD:jean.json"])?,
    }))
}

pub fn verify(repo: &str, baseline: &RuntimeConfigBaseline) -> Result<(), String> {
    if hash(&bytes(repo)?) != baseline.working_sha256
        || git(repo, &["rev-parse", "HEAD:jean.json"])? != baseline.head_blob
        || !cached_config(repo)?.is_empty()
    {
        return Err("Configuration runtime modifiée depuis la capture ; validation refusée".into());
    }
    Ok(())
}

pub fn is_clean(repo: &str, baseline: Option<&RuntimeConfigBaseline>) -> Result<bool, String> {
    if let Some(baseline) = baseline {
        verify(repo, baseline)?;
        Ok(git(
            repo,
            &["status", "--porcelain", "--", ".", ":(exclude)jean.json"],
        )?
        .is_empty())
    } else {
        Ok(git(repo, &["status", "--porcelain"])?.is_empty())
    }
}

/// Snapshot a partial owned tree, including the index and untracked content.
/// It is an interruption guard, not proof of authorship during an active agent.
pub fn working_tree_fingerprint(
    repo: &str,
    baseline: Option<&RuntimeConfigBaseline>,
) -> Result<String, String> {
    if let Some(baseline) = baseline {
        verify(repo, baseline)?;
    }
    let run = |args: &[&str]| -> Result<Vec<u8>, String> {
        let output = crate::platform::silent_command("git")
            .args(args)
            .current_dir(repo)
            .output()
            .map_err(|e| format!("Empreinte worktree inaccessible : {e}"))?;
        if !output.status.success() {
            return Err("Git ne permet pas de confirmer les modifications conservées".into());
        }
        if output.stdout.len() > 64 * 1024 * 1024 {
            return Err("Modifications trop volumineuses pour attribution sûre".into());
        }
        Ok(output.stdout)
    };
    let mut digest = Sha256::new();
    for base_args in [
        vec!["status", "--porcelain", "-z"],
        vec!["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"],
        vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            "--cached",
        ],
    ] {
        let mut args = base_args;
        args.extend(["--", "."]);
        if baseline.is_some() {
            args.push(":(exclude)jean.json");
        }
        let content = run(&args)?;
        digest.update((content.len() as u64).to_le_bytes());
        digest.update(content);
    }
    let mut args = vec![
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
    ];
    if baseline.is_some() {
        args.push(":(exclude)jean.json");
    }
    let names = run(&args)?;
    let mut total = 0_u64;
    for name in names
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let name = std::str::from_utf8(name).map_err(|_| "Nom non UTF-8 : attribution refusée")?;
        let relative = Path::new(name);
        if relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err("Chemin non relatif : attribution refusée".into());
        }
        let path = Path::new(repo).join(relative);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|e| format!("Fichier de correction inaccessible : {e}"))?;
        let content = if metadata.file_type().is_symlink() {
            fs::read_link(&path)
                .map_err(|e| e.to_string())?
                .into_os_string()
                .into_string()
                .map_err(|_| "Lien non UTF-8 : attribution refusée")?
                .into_bytes()
        } else if metadata.is_file() && metadata.len() <= 16 * 1024 * 1024 {
            fs::read(&path).map_err(|e| e.to_string())?
        } else {
            return Err(
                "Fichier non attribuable ou trop volumineux ; modifications conservées".into(),
            );
        };
        total = total.saturating_add(content.len() as u64);
        if total > 64 * 1024 * 1024 {
            return Err("Modifications non suivies trop volumineuses ; attribution refusée".into());
        }
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        digest.update([u8::from(metadata.file_type().is_symlink())]);
        digest.update((content.len() as u64).to_le_bytes());
        digest.update(content);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn stage_correction(
    repo: &str,
    baseline: Option<&RuntimeConfigBaseline>,
) -> Result<(), String> {
    if let Some(baseline) = baseline {
        verify(repo, baseline)?;
        git(repo, &["add", "--all", "--", ".", ":(exclude)jean.json"])?;
        verify(repo, baseline)?;
    } else {
        git(repo, &["add", "--all"])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        _temp: tempfile::TempDir,
        repo: String,
        root: String,
        copied: Vec<u8>,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let repo = temp.path().join("worktree");
            let root = temp.path().join("root");
            fs::create_dir(&repo).unwrap();
            fs::create_dir(&root).unwrap();
            let repo = repo.to_str().unwrap().to_owned();
            let root = root.to_str().unwrap().to_owned();
            git(&repo, &["init", "--quiet"]).unwrap();
            git(&repo, &["config", "user.email", "fixture@example.invalid"]).unwrap();
            git(&repo, &["config", "user.name", "Fixture"]).unwrap();
            fs::write(format!("{repo}/jean.json"), "{}").unwrap();
            fs::write(format!("{repo}/code.txt"), "initial").unwrap();
            git(&repo, &["add", "--all"]).unwrap();
            git(&repo, &["commit", "--quiet", "-m", "fixture"]).unwrap();
            let copied =
                br#"{"scripts":{"setup":"cp \"$JEAN_ROOT_PATH/jean.json\" . && bun install"}}"#
                    .to_vec();
            fs::write(format!("{root}/jean.json"), &copied).unwrap();
            fs::write(format!("{repo}/jean.json"), &copied).unwrap();
            Self {
                _temp: temp,
                repo,
                root,
                copied,
            }
        }
        fn baseline(&self) -> RuntimeConfigBaseline {
            capture(&self.repo, &self.root).unwrap().unwrap()
        }
    }

    #[test]
    fn owned_tree_fingerprint_detects_foreign_content_index_and_untracked_edits() {
        let f = Fixture::new();
        let baseline = f.baseline();
        fs::write(format!("{}/code.txt", f.repo), "partial correction").unwrap();
        let owned = working_tree_fingerprint(&f.repo, Some(&baseline)).unwrap();
        assert_eq!(
            owned,
            working_tree_fingerprint(&f.repo, Some(&baseline)).unwrap()
        );
        fs::write(format!("{}/code.txt", f.repo), "foreign same-path edit").unwrap();
        assert_ne!(
            owned,
            working_tree_fingerprint(&f.repo, Some(&baseline)).unwrap()
        );
        fs::write(format!("{}/code.txt", f.repo), "partial correction").unwrap();
        fs::write(format!("{}/foreign.txt", f.repo), "foreign untracked").unwrap();
        assert_ne!(
            owned,
            working_tree_fingerprint(&f.repo, Some(&baseline)).unwrap()
        );
        fs::remove_file(format!("{}/foreign.txt", f.repo)).unwrap();
        git(&f.repo, &["add", "code.txt"]).unwrap();
        assert_ne!(
            owned,
            working_tree_fingerprint(&f.repo, Some(&baseline)).unwrap()
        );
        assert_eq!(bytes(&f.repo).unwrap(), f.copied);
    }

    #[test]
    fn copied_root_is_recognized_and_only_configuration_is_clean() {
        let f = Fixture::new();
        let baseline = f.baseline();
        assert!(is_clean(&f.repo, Some(&baseline)).unwrap());
        assert!(!is_clean(&f.repo, None).unwrap());
        fs::write(format!("{}/code.txt", f.repo), "changed").unwrap();
        assert!(!is_clean(&f.repo, Some(&baseline)).unwrap());
    }

    #[test]
    fn arbitrary_local_or_staged_configuration_is_not_recognized() {
        let f = Fixture::new();
        fs::write(format!("{}/jean.json", f.repo), "{\"custom\":true}").unwrap();
        assert!(capture(&f.repo, &f.root).unwrap().is_none());
        fs::write(format!("{}/jean.json", f.repo), &f.copied).unwrap();
        git(&f.repo, &["add", "jean.json"]).unwrap();
        assert!(capture(&f.repo, &f.root).unwrap().is_none());
    }

    #[test]
    fn changed_configuration_or_head_invalidates_baseline() {
        let f = Fixture::new();
        let baseline = f.baseline();
        fs::write(format!("{}/jean.json", f.repo), "{}").unwrap();
        assert!(is_clean(&f.repo, Some(&baseline)).is_err());
        assert!(stage_correction(&f.repo, Some(&baseline)).is_err());
        fs::write(format!("{}/jean.json", f.repo), &f.copied).unwrap();
        git(&f.repo, &["add", "jean.json"]).unwrap();
        assert!(is_clean(&f.repo, Some(&baseline)).is_err());
        git(&f.repo, &["commit", "--quiet", "-m", "changed config"]).unwrap();
        assert!(is_clean(&f.repo, Some(&baseline)).is_err());
    }

    #[test]
    fn correction_stages_code_without_staging_or_rewriting_runtime_config() {
        let f = Fixture::new();
        let baseline = f.baseline();
        fs::write(format!("{}/code.txt", f.repo), "fixed").unwrap();
        fs::write(format!("{}/new.txt", f.repo), "new").unwrap();
        fs::create_dir(format!("{}/nested", f.repo)).unwrap();
        fs::write(format!("{}/nested/jean.json", f.repo), "{}").unwrap();
        stage_correction(&f.repo, Some(&baseline)).unwrap();
        assert_eq!(
            git(&f.repo, &["diff", "--cached", "--name-only"]).unwrap(),
            "code.txt\nnested/jean.json\nnew.txt"
        );
        assert_eq!(fs::read(format!("{}/jean.json", f.repo)).unwrap(), f.copied);
    }

    #[test]
    fn no_baseline_stages_normally_and_missing_configuration_fails_closed() {
        let f = Fixture::new();
        stage_correction(&f.repo, None).unwrap();
        assert_eq!(cached_config(&f.repo).unwrap(), "jean.json");
        git(&f.repo, &["reset", "--quiet", "HEAD", "--", "jean.json"]).unwrap();
        fs::remove_file(format!("{}/jean.json", f.root)).unwrap();
        assert!(capture(&f.repo, &f.root).is_err());
    }

    #[test]
    fn missing_copy_instruction_and_same_root_are_rejected() {
        let f = Fixture::new();
        assert!(capture(&f.repo, &f.repo).unwrap().is_none());
        let bytes = br#"{"scripts":{"setup":"echo cp \"$JEAN_ROOT_PATH/jean.json\" ."}}"#;
        fs::write(format!("{}/jean.json", f.repo), bytes).unwrap();
        fs::write(format!("{}/jean.json", f.root), bytes).unwrap();
        assert!(capture(&f.repo, &f.root).unwrap().is_none());
    }
}
