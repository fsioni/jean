use crate::platform::silent_command;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Debug, Serialize)]
pub struct PluginStatus {
    pub installed: bool,
    pub version: Option<String>,
}

const SUPERPOWERS_GIT_WORKTREE_SKILL: &str = "using-git-worktrees";

fn superpowers_claude_plugin_target() -> &'static str {
    "superpowers@claude-plugins-official"
}

fn is_blocked_superpowers_skill_dir(name: &str) -> bool {
    name == SUPERPOWERS_GIT_WORKTREE_SKILL
        || name == format!("superpowers-{SUPERPOWERS_GIT_WORKTREE_SKILL}")
}

#[tauri::command]
pub async fn check_opinionated_plugin_status(
    app: AppHandle,
    plugin_name: String,
) -> Result<PluginStatus, String> {
    match plugin_name.as_str() {
        "rtk" => check_rtk_status().await,
        "caveman" => check_caveman_status(&app).await,
        "superpowers" => check_superpowers_status(&app).await,
        _ => Err(format!("Unknown plugin: {plugin_name}")),
    }
}

#[tauri::command]
pub async fn install_opinionated_plugin(
    app: AppHandle,
    plugin_name: String,
) -> Result<String, String> {
    match plugin_name.as_str() {
        "rtk" => install_rtk().await,
        "caveman" => install_caveman(&app).await,
        "superpowers" => install_superpowers(&app).await,
        _ => Err(format!("Unknown plugin: {plugin_name}")),
    }
}

#[tauri::command]
pub async fn uninstall_opinionated_plugin(
    app: AppHandle,
    plugin_name: String,
) -> Result<String, String> {
    match plugin_name.as_str() {
        "caveman" => uninstall_caveman(&app).await,
        "superpowers" => uninstall_superpowers(&app).await,
        "rtk" => {
            Err("RTK is a system-wide CLI; uninstall it with your package manager".to_string())
        }
        _ => Err(format!("Unknown plugin: {plugin_name}")),
    }
}

async fn check_rtk_status() -> Result<PluginStatus, String> {
    let result = tokio::task::spawn_blocking(|| silent_command("rtk").arg("--version").output())
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let version = extract_version(&stdout);
            Ok(PluginStatus {
                installed: true,
                version,
            })
        }
        _ => Ok(PluginStatus {
            installed: false,
            version: None,
        }),
    }
}

async fn check_caveman_status(app: &AppHandle) -> Result<PluginStatus, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let installed_backends = detected_jean_backends(app);

    let home_for_check = home.clone();
    let covered_backends = tokio::task::spawn_blocking(move || {
        installed_backends
            .into_iter()
            .filter(|backend| caveman_installed_for_backend(&home_for_check, backend))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;

    let installed = caveman_status_installed(&covered_backends, &detected_jean_backends(app));

    let version = if covered_backends.is_empty() {
        None
    } else {
        Some(covered_backends.join(", "))
    };

    Ok(PluginStatus { installed, version })
}

async fn install_rtk() -> Result<String, String> {
    // Try brew first on macOS
    let brew_result = tokio::task::spawn_blocking(|| {
        silent_command("brew")
            .args(["install", "rtk-ai/tap/rtk"])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?;

    let install_ok = match brew_result {
        Ok(output) if output.status.success() => true,
        _ => {
            // Fallback to curl installer
            let curl_result = tokio::task::spawn_blocking(|| {
                silent_command("sh")
                    .args([
                        "-c",
                        "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
                    ])
                    .output()
            })
            .await
            .map_err(|e| e.to_string())?;

            match curl_result {
                Ok(output) if output.status.success() => true,
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(format!("RTK installation failed: {stderr}"));
                }
                Err(e) => return Err(format!("Failed to run installer: {e}")),
            }
        }
    };

    if install_ok {
        // Run post-install setup
        let init_result =
            tokio::task::spawn_blocking(|| silent_command("rtk").args(["init", "-g"]).output())
                .await
                .map_err(|e| e.to_string())?;

        match init_result {
            Ok(output) if output.status.success() => {
                Ok("RTK installed and initialized successfully".to_string())
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Ok(format!("RTK installed but init had warnings: {stderr}"))
            }
            Err(e) => Ok(format!("RTK installed but init failed: {e}")),
        }
    } else {
        Err("RTK installation failed".to_string())
    }
}

async fn install_caveman(app: &AppHandle) -> Result<String, String> {
    let backends = detected_jean_backends(app);
    if backends.is_empty() {
        return Err("Install at least one Jean AI backend before installing Caveman".to_string());
    }

    let mut args = vec![
        "-y".to_string(),
        "github:JuliusBrussee/caveman".to_string(),
        "--".to_string(),
        "--non-interactive".to_string(),
        "--with-init".to_string(),
    ];

    for backend in &backends {
        args.push("--only".to_string());
        args.push((*backend).to_string());
    }

    let install_result = tokio::task::spawn_blocking(move || {
        let mut command = silent_command("npx");
        command.args(args);
        command.output()
    })
    .await
    .map_err(|e| e.to_string())?;

    match install_result {
        Ok(output) if output.status.success() => Ok(format!(
            "Caveman installed for Jean backends: {}",
            backends.join(", ")
        )),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if stderr.is_empty() { stdout } else { stderr };
            Err(format!("Failed to install Caveman: {detail}"))
        }
        Err(e) => Err(format!("Failed to run Caveman installer with npx: {e}")),
    }
}

async fn check_superpowers_status(app: &AppHandle) -> Result<PluginStatus, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let installed_backends = detected_jean_backends(app);
    let detected_count = installed_backends.len();

    let home_for_check = home.clone();
    let covered_backends = tokio::task::spawn_blocking(move || {
        installed_backends
            .into_iter()
            .filter(|backend| superpowers_installed_for_backend(&home_for_check, backend))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;

    let version = if covered_backends.is_empty() {
        None
    } else {
        Some(covered_backends.join(", "))
    };

    Ok(PluginStatus {
        installed: detected_count > 0 && covered_backends.len() == detected_count,
        version,
    })
}

fn plugin_installed_marker(home: &std::path::Path, plugin_id: &str) -> bool {
    let data_dir = home.join(".claude").join("plugins").join("data");
    if data_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&data_dir) {
            let prefix = format!("{plugin_id}-");
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.starts_with(&prefix) || name == plugin_id {
                    return true;
                }
            }
        }
    }

    let plugins_cache = home.join(".claude").join("plugins").join("cache");
    if plugins_cache.exists() {
        if let Ok(entries) = std::fs::read_dir(&plugins_cache) {
            for entry in entries.flatten() {
                let entry_name = entry.file_name().to_string_lossy().to_lowercase();
                if entry_name.contains(plugin_id) {
                    return true;
                }
                let path = entry.path();
                if path.is_dir() {
                    if let Ok(children) = std::fs::read_dir(&path) {
                        for child in children.flatten() {
                            let child_name = child.file_name().to_string_lossy().to_lowercase();
                            if child_name.contains(plugin_id) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }

    let skills_dir = home.join(".claude").join("skills");
    if skills_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&skills_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.contains(plugin_id) && entry.path().join("SKILL.md").exists() {
                    return true;
                }
            }
        }
    }

    false
}

fn remove_path_if_exists(path: &Path, removed: &mut Vec<String>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove directory {path:?}: {e}"))?;
    } else {
        std::fs::remove_file(path).map_err(|e| format!("Failed to remove file {path:?}: {e}"))?;
    }

    removed.push(path.display().to_string());
    Ok(())
}

fn remove_matching_skill_dirs(
    skills_dir: &Path,
    skill_id: &str,
    removed: &mut Vec<String>,
) -> Result<(), String> {
    if !skills_dir.is_dir() {
        return Ok(());
    }

    let entries = std::fs::read_dir(skills_dir)
        .map_err(|e| format!("Failed to read skills dir {skills_dir:?}: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if path.is_dir() && path.join("SKILL.md").exists() && name.contains(skill_id) {
            remove_path_if_exists(&path, removed)?;
        }
    }

    Ok(())
}

fn claude_plugin_keys(plugin_id: &str) -> Vec<String> {
    match plugin_id {
        "superpowers" => vec![
            "superpowers@claude-plugins-official".to_string(),
            "superpowers@superpowers".to_string(),
            "superpowers@superpowers-dev".to_string(),
        ],
        "caveman" => vec!["caveman@caveman".to_string()],
        _ => Vec::new(),
    }
}

fn remove_json_object_keys(
    json_path: &Path,
    object_path: &[&str],
    keys: &[String],
    removed: &mut Vec<String>,
) -> Result<(), String> {
    if !json_path.exists() {
        return Ok(());
    }

    let contents = std::fs::read_to_string(json_path)
        .map_err(|e| format!("Failed to read JSON file {json_path:?}: {e}"))?;
    let mut json: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse JSON file {json_path:?}: {e}"))?;

    let mut target = &mut json;
    for segment in object_path {
        let Some(next) = target.get_mut(*segment) else {
            return Ok(());
        };
        target = next;
    }

    let Some(object) = target.as_object_mut() else {
        return Ok(());
    };

    let mut changed = false;
    for key in keys {
        if object.remove(key).is_some() {
            removed.push(format!("{} [{}]", json_path.display(), key));
            changed = true;
        }
    }

    if changed {
        let rendered = serde_json::to_string_pretty(&json)
            .map_err(|e| format!("Failed to render JSON file {json_path:?}: {e}"))?;
        std::fs::write(json_path, format!("{rendered}\n"))
            .map_err(|e| format!("Failed to write JSON file {json_path:?}: {e}"))?;
    }

    Ok(())
}

fn remove_claude_plugin_registration(
    home: &Path,
    plugin_id: &str,
    removed: &mut Vec<String>,
) -> Result<(), String> {
    let keys = claude_plugin_keys(plugin_id);
    if keys.is_empty() {
        return Ok(());
    }

    remove_json_object_keys(
        &home.join(".claude").join("settings.json"),
        &["enabledPlugins"],
        &keys,
        removed,
    )?;
    remove_json_object_keys(
        &home
            .join(".claude")
            .join("plugins")
            .join("installed_plugins.json"),
        &["plugins"],
        &keys,
        removed,
    )?;

    Ok(())
}

fn remove_claude_plugin_markers(
    home: &Path,
    plugin_id: &str,
    removed: &mut Vec<String>,
) -> Result<(), String> {
    for dir in [
        home.join(".claude").join("skills"),
        home.join(".claude").join("plugins").join("data"),
        home.join(".claude").join("plugins").join("cache"),
    ] {
        if !dir.is_dir() {
            continue;
        }

        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read Claude plugin dir {dir:?}: {e}"))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.contains(plugin_id) {
                remove_path_if_exists(&entry.path(), removed)?;
            }
        }
    }

    Ok(())
}

fn codex_plugin_key(plugin_id: &str) -> String {
    format!("{plugin_id}@openai-curated")
}

fn codex_plugin_registered(home: &Path, plugin_id: &str) -> bool {
    let config_path = home.join(".codex").join("config.toml");
    let Ok(contents) = std::fs::read_to_string(config_path) else {
        return false;
    };
    let Ok(doc) = contents.parse::<toml_edit::DocumentMut>() else {
        return contents.contains(&format!("[plugins.\"{}\"]", codex_plugin_key(plugin_id)));
    };

    doc.get("plugins")
        .and_then(|plugins| plugins.as_table())
        .and_then(|plugins| plugins.get(&codex_plugin_key(plugin_id)))
        .is_some()
}

fn remove_codex_plugin_registration(
    home: &Path,
    plugin_id: &str,
    removed: &mut Vec<String>,
) -> Result<(), String> {
    let config_path = home.join(".codex").join("config.toml");
    if !config_path.exists() {
        return Ok(());
    }

    let contents = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read Codex config {config_path:?}: {e}"))?;
    let mut doc = contents
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Failed to parse Codex config {config_path:?}: {e}"))?;

    let key = codex_plugin_key(plugin_id);
    let removed_entry = doc
        .get_mut("plugins")
        .and_then(|plugins| plugins.as_table_mut())
        .and_then(|plugins| plugins.remove(&key))
        .is_some();

    if removed_entry {
        std::fs::write(&config_path, doc.to_string())
            .map_err(|e| format!("Failed to write Codex config {config_path:?}: {e}"))?;
        removed.push(format!("{} [{}]", config_path.display(), key));
    }

    Ok(())
}

fn remove_codex_plugin_cache(
    home: &Path,
    plugin_id: &str,
    removed: &mut Vec<String>,
) -> Result<(), String> {
    remove_path_if_exists(
        &home
            .join(".codex")
            .join("plugins")
            .join("cache")
            .join("openai-curated")
            .join(plugin_id),
        removed,
    )?;
    remove_path_if_exists(
        &home
            .join(".codex")
            .join(".tmp")
            .join("plugins")
            .join("plugins")
            .join(plugin_id),
        removed,
    )?;

    Ok(())
}

fn uninstall_caveman_from_home(home: &Path) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();

    remove_claude_plugin_registration(home, "caveman", &mut removed)?;
    remove_claude_plugin_markers(home, "caveman", &mut removed)?;
    remove_matching_skill_dirs(&home.join(".codex").join("skills"), "caveman", &mut removed)?;

    let opencode_dir = opencode_config_dir(home);
    remove_matching_skill_dirs(&opencode_dir.join("skills"), "caveman", &mut removed)?;
    remove_path_if_exists(&opencode_dir.join("plugins").join("caveman"), &mut removed)?;
    remove_path_if_exists(
        &opencode_dir.join("commands").join("caveman.md"),
        &mut removed,
    )?;

    remove_matching_skill_dirs(
        &home.join(".cursor").join("skills-cursor"),
        "caveman",
        &mut removed,
    )?;
    remove_path_if_exists(
        &home.join(".cursor").join("rules").join("caveman.mdc"),
        &mut removed,
    )?;

    Ok(removed)
}

fn uninstall_superpowers_from_home(home: &Path) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();

    remove_claude_plugin_registration(home, "superpowers", &mut removed)?;
    remove_claude_plugin_markers(home, "superpowers", &mut removed)?;
    remove_matching_skill_dirs(
        &home.join(".codex").join("skills"),
        "superpowers",
        &mut removed,
    )?;
    remove_codex_plugin_registration(home, "superpowers", &mut removed)?;
    remove_codex_plugin_cache(home, "superpowers", &mut removed)?;
    remove_matching_skill_dirs(
        &opencode_config_dir(home).join("skills"),
        "superpowers",
        &mut removed,
    )?;
    remove_matching_skill_dirs(
        &home.join(".cursor").join("skills-cursor"),
        "superpowers",
        &mut removed,
    )?;

    Ok(removed)
}

async fn uninstall_caveman(_app: &AppHandle) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let removed = tokio::task::spawn_blocking(move || uninstall_caveman_from_home(&home))
        .await
        .map_err(|e| e.to_string())??;

    if removed.is_empty() {
        Ok("Caveman was not installed".to_string())
    } else {
        Ok(format!(
            "Caveman uninstalled from {} location{}",
            removed.len(),
            if removed.len() == 1 { "" } else { "s" }
        ))
    }
}

async fn uninstall_superpowers(_app: &AppHandle) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let removed = tokio::task::spawn_blocking(move || uninstall_superpowers_from_home(&home))
        .await
        .map_err(|e| e.to_string())??;

    if removed.is_empty() {
        Ok("Superpowers was not installed".to_string())
    } else {
        Ok(format!(
            "Superpowers uninstalled from {} location{}",
            removed.len(),
            if removed.len() == 1 { "" } else { "s" }
        ))
    }
}

fn detected_jean_backends(app: &AppHandle) -> Vec<&'static str> {
    let candidates: Vec<(&'static str, Option<PathBuf>)> = vec![
        ("claude", Some(crate::claude_cli::resolve_cli_binary(app))),
        ("codex", crate::codex_cli::resolve_cli_binary(app).ok()),
        (
            "opencode",
            Some(crate::opencode_cli::resolve_cli_binary(app)),
        ),
        ("cursor", Some(crate::cursor_cli::resolve_cli_binary(app))),
    ];

    candidates
        .into_iter()
        .filter_map(|(backend, path)| path.filter(|p| p.exists()).map(|_| backend))
        .collect()
}

fn caveman_status_installed(covered_backends: &[&str], _detected_backends: &[&str]) -> bool {
    !covered_backends.is_empty()
}

fn caveman_installed_for_backend(home: &Path, backend: &str) -> bool {
    match backend {
        "claude" => plugin_installed_marker(home, "caveman"),
        "codex" => skill_installed_marker(&home.join(".codex").join("skills"), "caveman"),
        "opencode" => {
            let config_dir = opencode_config_dir(home);
            config_dir
                .join("plugins")
                .join("caveman")
                .join("plugin.js")
                .exists()
                || skill_installed_marker(&config_dir.join("skills"), "caveman")
                || config_dir.join("commands").join("caveman.md").exists()
        }
        "cursor" => {
            skill_installed_marker(&home.join(".cursor").join("skills-cursor"), "caveman")
                || home
                    .join(".cursor")
                    .join("rules")
                    .join("caveman.mdc")
                    .exists()
        }
        _ => false,
    }
}

fn superpowers_installed_for_backend(home: &Path, backend: &str) -> bool {
    match backend {
        "claude" => plugin_installed_marker(home, "superpowers"),
        "codex" => {
            skill_installed_marker(&home.join(".codex").join("skills"), "superpowers")
                || codex_plugin_registered(home, "superpowers")
                || home
                    .join(".codex")
                    .join("plugins")
                    .join("cache")
                    .join("openai-curated")
                    .join("superpowers")
                    .exists()
        }
        "opencode" => {
            skill_installed_marker(&opencode_config_dir(home).join("skills"), "superpowers")
        }
        "cursor" => {
            skill_installed_marker(&home.join(".cursor").join("skills-cursor"), "superpowers")
        }
        _ => false,
    }
}

fn backend_skills_dir(home: &Path, backend: &str) -> Option<PathBuf> {
    match backend {
        "codex" => Some(home.join(".codex").join("skills")),
        "opencode" => Some(opencode_config_dir(home).join("skills")),
        "cursor" => Some(home.join(".cursor").join("skills-cursor")),
        _ => None,
    }
}

fn find_superpowers_skills_dir(home: &Path) -> Option<PathBuf> {
    for root in [
        home.join(".claude").join("plugins").join("cache"),
        home.join(".claude").join("plugins").join("data"),
    ] {
        if let Some(found) = find_named_skills_dir(&root, "superpowers", 4) {
            return Some(found);
        }
    }
    None
}

fn find_named_skills_dir(root: &Path, name_hint: &str, max_depth: usize) -> Option<PathBuf> {
    if max_depth == 0 || !root.is_dir() {
        return None;
    }

    let root_name = root
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let direct = root.join("skills");
    if root_name.contains(name_hint) && direct.is_dir() && dir_contains_skill(&direct) {
        return Some(direct);
    }

    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_named_skills_dir(&path, name_hint, max_depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

fn dir_contains_skill(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| entry.path().is_dir() && entry.path().join("SKILL.md").exists())
}

fn copy_superpowers_skills(
    source_skills_dir: &Path,
    target_skills_dir: &Path,
) -> Result<usize, String> {
    std::fs::create_dir_all(target_skills_dir)
        .map_err(|e| format!("Failed to create skills dir {target_skills_dir:?}: {e}"))?;

    let entries = std::fs::read_dir(source_skills_dir)
        .map_err(|e| format!("Failed to read Superpowers skills dir {source_skills_dir:?}: {e}"))?;

    let mut copied = 0;
    for entry in entries.flatten() {
        let source = entry.path();
        if !source.is_dir() || !source.join("SKILL.md").exists() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if is_blocked_superpowers_skill_dir(&name) {
            continue;
        }
        let target_name = if name.starts_with("superpowers") {
            name
        } else {
            format!("superpowers-{name}")
        };
        if is_blocked_superpowers_skill_dir(&target_name) {
            continue;
        }
        let target = target_skills_dir.join(target_name);
        copy_dir_replace(&source, &target)?;
        copied += 1;
    }

    Ok(copied)
}

fn copy_dir_replace(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        std::fs::remove_dir_all(target)
            .map_err(|e| format!("Failed to remove existing dir {target:?}: {e}"))?;
    }
    copy_dir_recursive(source, target)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| format!("Failed to create dir {target:?}: {e}"))?;

    let entries =
        std::fs::read_dir(source).map_err(|e| format!("Failed to read dir {source:?}: {e}"))?;
    for entry in entries.flatten() {
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            std::fs::copy(&source_path, &target_path)
                .map_err(|e| format!("Failed to copy {source_path:?} to {target_path:?}: {e}"))?;
        }
    }
    Ok(())
}

fn clone_superpowers_skills_dir() -> Result<PathBuf, String> {
    let temp = std::env::temp_dir().join(format!("jean-superpowers-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp)
        .map_err(|e| format!("Failed to create temp dir {temp:?}: {e}"))?;
    let repo_dir = temp.join("superpowers");
    let output = silent_command("git")
        .args([
            "clone",
            "--depth",
            "1",
            "https://github.com/obra/superpowers",
            repo_dir.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("Failed to run git clone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("Failed to clone Superpowers: {detail}"));
    }

    let skills_dir = repo_dir.join("skills");
    if !skills_dir.is_dir() {
        return Err("Superpowers repository did not contain a skills directory".to_string());
    }
    Ok(skills_dir)
}

fn opencode_config_dir(home: &Path) -> PathBuf {
    if let Ok(xdg_config_home) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg_config_home).join("opencode");
    }

    #[cfg(windows)]
    {
        if let Ok(app_data) = std::env::var("APPDATA") {
            return PathBuf::from(app_data).join("opencode");
        }
        return home.join("AppData").join("Roaming").join("opencode");
    }

    #[cfg(not(windows))]
    {
        home.join(".config").join("opencode")
    }
}

fn skill_installed_marker(skills_dir: &Path, skill_id: &str) -> bool {
    let direct = skills_dir.join(skill_id).join("SKILL.md");
    if direct.exists() {
        return true;
    }

    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return false;
    };

    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        name.contains(skill_id) && entry.path().join("SKILL.md").exists()
    })
}

fn remove_superpowers_git_worktree_skill(
    home: &Path,
    removed: &mut Vec<String>,
) -> Result<(), String> {
    let blocked_names = [
        SUPERPOWERS_GIT_WORKTREE_SKILL.to_string(),
        format!("superpowers-{SUPERPOWERS_GIT_WORKTREE_SKILL}"),
    ];

    for skills_dir in [
        home.join(".claude").join("skills"),
        home.join(".codex").join("skills"),
        opencode_config_dir(home).join("skills"),
        home.join(".cursor").join("skills-cursor"),
    ] {
        for name in &blocked_names {
            remove_path_if_exists(&skills_dir.join(name), removed)?;
        }
    }

    for root in [
        home.join(".claude").join("plugins").join("cache"),
        home.join(".claude").join("plugins").join("data"),
        home.join(".codex")
            .join("plugins")
            .join("cache")
            .join("openai-curated")
            .join("superpowers"),
        home.join(".codex")
            .join(".tmp")
            .join("plugins")
            .join("plugins")
            .join("superpowers"),
    ] {
        remove_named_skill_dirs_under(&root, &blocked_names, removed)?;
    }

    Ok(())
}

pub fn cleanup_disallowed_opinionated_skills_on_startup() -> Result<usize, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    cleanup_disallowed_opinionated_skills_in_home(&home)
}

fn cleanup_disallowed_opinionated_skills_in_home(home: &Path) -> Result<usize, String> {
    let mut removed = Vec::new();
    remove_superpowers_git_worktree_skill(home, &mut removed)?;
    Ok(removed.len())
}

fn remove_named_skill_dirs_under(
    root: &Path,
    blocked_names: &[String],
    removed: &mut Vec<String>,
) -> Result<(), String> {
    if !root.is_dir() {
        return Ok(());
    }

    let entries =
        std::fs::read_dir(root).map_err(|e| format!("Failed to read directory {root:?}: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if blocked_names.iter().any(|blocked| blocked == &name) && path.join("SKILL.md").exists() {
            remove_path_if_exists(&path, removed)?;
            continue;
        }

        remove_named_skill_dirs_under(&path, blocked_names, removed)?;
    }

    Ok(())
}

async fn install_superpowers(app: &AppHandle) -> Result<String, String> {
    let backends = detected_jean_backends(app);
    if backends.is_empty() {
        return Err(
            "Install at least one Jean AI backend before installing Superpowers".to_string(),
        );
    }

    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let mut installed = Vec::new();
    let mut warnings = Vec::new();

    if backends.contains(&"claude") {
        let binary_path = crate::claude_cli::resolve_cli_binary(app);
        let bin = binary_path.clone();
        let add_result = tokio::task::spawn_blocking(move || {
            silent_command(&bin)
                .args(["plugin", "marketplace", "add", "obra/superpowers"])
                .output()
        })
        .await
        .map_err(|e| e.to_string())?;

        match add_result {
            Ok(output) if !output.status.success() => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                warnings.push(format!("Claude marketplace add failed: {stderr}"));
            }
            Err(e) => warnings.push(format!("Failed to run Claude CLI marketplace add: {e}")),
            _ => {}
        }

        let bin = binary_path;
        let install_result = tokio::task::spawn_blocking(move || {
            silent_command(&bin)
                .args(["plugin", "install", superpowers_claude_plugin_target()])
                .output()
        })
        .await
        .map_err(|e| e.to_string())?;

        match install_result {
            Ok(output) if output.status.success() => installed.push("claude"),
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                warnings.push(format!("Claude plugin install failed: {stderr}"));
            }
            Err(e) => warnings.push(format!("Failed to run Claude CLI plugin install: {e}")),
        }
    }

    let source_from_claude = home.clone();
    let source_skills_dir =
        tokio::task::spawn_blocking(move || find_superpowers_skills_dir(&source_from_claude))
            .await
            .map_err(|e| e.to_string())?;

    let mut cloned_repo_root: Option<PathBuf> = None;
    let source_skills_dir = match source_skills_dir {
        Some(path) => path,
        None => {
            let skills_dir = tokio::task::spawn_blocking(clone_superpowers_skills_dir)
                .await
                .map_err(|e| e.to_string())??;
            cloned_repo_root = skills_dir
                .parent()
                .and_then(|repo| repo.parent())
                .map(Path::to_path_buf);
            skills_dir
        }
    };

    for backend in &backends {
        if *backend == "claude" {
            continue;
        }

        let Some(target_dir) = backend_skills_dir(&home, backend) else {
            continue;
        };
        let source = source_skills_dir.clone();
        let result =
            tokio::task::spawn_blocking(move || copy_superpowers_skills(&source, &target_dir))
                .await
                .map_err(|e| e.to_string())?;

        match result {
            Ok(count) if count > 0 => installed.push(*backend),
            Ok(_) => warnings.push(format!(
                "No Superpowers skills found to install for {backend}"
            )),
            Err(e) => warnings.push(format!("Failed to install Superpowers for {backend}: {e}")),
        }
    }

    if let Some(path) = cloned_repo_root {
        let _ = std::fs::remove_dir_all(path);
    }

    let home_for_cleanup = home.clone();
    let cleanup_result = tokio::task::spawn_blocking(move || {
        let mut removed = Vec::new();
        remove_superpowers_git_worktree_skill(&home_for_cleanup, &mut removed)?;
        Ok::<usize, String>(removed.len())
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Err(e) = cleanup_result {
        warnings.push(format!(
            "Failed to remove Superpowers git worktree skill: {e}"
        ));
    }

    if installed.is_empty() {
        let detail = if warnings.is_empty() {
            "No backend-specific installer succeeded".to_string()
        } else {
            warnings.join("; ")
        };
        return Err(format!("Failed to install Superpowers: {detail}"));
    }

    let mut message = format!(
        "Superpowers installed for Jean backends: {}",
        installed.join(", ")
    );
    if !warnings.is_empty() {
        message.push_str(&format!(". Warnings: {}", warnings.join("; ")));
    }

    Ok(message)
}

fn extract_version(s: &str) -> Option<String> {
    let re = regex::Regex::new(r"(\d+\.\d+(?:\.\d+)?)").ok()?;
    re.find(s).map(|m| m.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_marker_detects_direct_skill_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        let skill_dir = temp.path().join("caveman");
        std::fs::create_dir_all(&skill_dir).expect("create skill dir");
        std::fs::write(skill_dir.join("SKILL.md"), "# Caveman").expect("write skill");

        assert!(skill_installed_marker(temp.path(), "caveman"));
    }

    #[test]
    fn skill_marker_ignores_matching_dir_without_skill_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(temp.path().join("caveman")).expect("create skill dir");

        assert!(!skill_installed_marker(temp.path(), "caveman"));
    }

    #[test]
    #[cfg(not(windows))]
    fn backend_marker_detects_opencode_plugin() {
        if std::env::var_os("XDG_CONFIG_HOME").is_some() {
            return;
        }

        let temp = tempfile::tempdir().expect("tempdir");
        let plugin_dir = temp
            .path()
            .join(".config")
            .join("opencode")
            .join("plugins")
            .join("caveman");
        std::fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        std::fs::write(plugin_dir.join("plugin.js"), "// plugin").expect("write plugin");

        assert!(caveman_installed_for_backend(temp.path(), "opencode"));
    }

    #[test]
    fn caveman_status_is_installed_when_any_backend_is_covered() {
        assert!(caveman_status_installed(&["claude"], &["claude", "codex"]));
        assert!(!caveman_status_installed(&[], &["claude"]));
    }

    #[test]
    fn identifies_superpowers_git_worktree_skill_names() {
        assert!(is_blocked_superpowers_skill_dir("using-git-worktrees"));
        assert!(is_blocked_superpowers_skill_dir(
            "superpowers-using-git-worktrees"
        ));
        assert!(!is_blocked_superpowers_skill_dir("writing-plans"));
    }

    #[test]
    fn uses_official_claude_marketplace_for_superpowers_install() {
        assert_eq!(
            superpowers_claude_plugin_target(),
            "superpowers@claude-plugins-official"
        );
    }

    #[test]
    fn startup_cleanup_removes_only_superpowers_git_worktree_skill() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_skills = temp.path().join(".codex").join("skills");
        let blocked = codex_skills.join("superpowers-using-git-worktrees");
        let allowed = codex_skills.join("superpowers-writing-plans");
        std::fs::create_dir_all(&blocked).expect("create blocked skill");
        std::fs::create_dir_all(&allowed).expect("create allowed skill");
        std::fs::write(blocked.join("SKILL.md"), "# blocked").expect("write blocked");
        std::fs::write(allowed.join("SKILL.md"), "# allowed").expect("write allowed");

        let removed = cleanup_disallowed_opinionated_skills_in_home(temp.path()).expect("cleanup");

        assert_eq!(removed, 1);
        assert!(!blocked.exists());
        assert!(allowed.join("SKILL.md").exists());
    }

    #[test]
    fn backend_marker_detects_cursor_skill() {
        let temp = tempfile::tempdir().expect("tempdir");
        let skill_dir = temp
            .path()
            .join(".cursor")
            .join("skills-cursor")
            .join("caveman");
        std::fs::create_dir_all(&skill_dir).expect("create cursor skill dir");
        std::fs::write(skill_dir.join("SKILL.md"), "# Caveman").expect("write skill");

        assert!(caveman_installed_for_backend(temp.path(), "cursor"));
    }
}
