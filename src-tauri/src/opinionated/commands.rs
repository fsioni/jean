use crate::platform::silent_command;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Debug, Serialize)]
pub struct PluginStatus {
    pub installed: bool,
    pub version: Option<String>,
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

fn detected_jean_backends(app: &AppHandle) -> Vec<&'static str> {
    let candidates = [
        ("claude", crate::claude_cli::resolve_cli_binary(app)),
        ("codex", crate::codex_cli::resolve_cli_binary(app)),
        ("opencode", crate::opencode_cli::resolve_cli_binary(app)),
        ("cursor", crate::cursor_cli::resolve_cli_binary(app)),
    ];

    candidates
        .into_iter()
        .filter_map(|(backend, path)| path.exists().then_some(backend))
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
        "codex" => skill_installed_marker(&home.join(".codex").join("skills"), "superpowers"),
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
        let target_name = if name.starts_with("superpowers") {
            name
        } else {
            format!("superpowers-{name}")
        };
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
                .args(["plugin", "install", "superpowers@superpowers"])
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
