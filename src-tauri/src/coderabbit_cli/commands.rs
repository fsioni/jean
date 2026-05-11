//! Tauri commands for CodeRabbit CLI management.

use crate::http_server::EmitExt;
use crate::platform::silent_command;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

use super::config::{
    ensure_coderabbit_cli_dir, find_system_coderabbit_binary, get_coderabbit_binary_path,
    get_coderabbit_cli_dir, resolve_coderabbit_binary,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRabbitCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRabbitAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRabbitPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeRabbitInstallProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let _ = app.emit_all(
        "coderabbit-cli:install-progress",
        &CodeRabbitInstallProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

fn parse_version(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .split_whitespace()
        .find(|part| part.chars().any(|c| c.is_ascii_digit()) && part.contains('.'))
        .map(|s| s.trim_start_matches('v').to_string())
        .or_else(|| Some(trimmed.to_string()))
}

fn get_version(binary: &std::path::Path) -> Option<String> {
    let output = silent_command(binary).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

#[tauri::command]
pub async fn check_coderabbit_cli_installed(app: AppHandle) -> Result<CodeRabbitCliStatus, String> {
    let binary_path = resolve_coderabbit_binary(&app);
    if !binary_path.exists() {
        return Ok(CodeRabbitCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }

    Ok(CodeRabbitCliStatus {
        installed: true,
        version: get_version(&binary_path),
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub async fn detect_coderabbit_in_path(app: AppHandle) -> Result<CodeRabbitPathDetection, String> {
    let Some(found_path) = find_system_coderabbit_binary(&app) else {
        return Ok(CodeRabbitPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    };

    let version = get_version(&found_path);
    let package_manager = crate::platform::detect_package_manager(&found_path);

    Ok(CodeRabbitPathDetection {
        found: true,
        path: Some(found_path.to_string_lossy().to_string()),
        version,
        package_manager,
    })
}

#[tauri::command]
pub async fn check_coderabbit_cli_auth(app: AppHandle) -> Result<CodeRabbitAuthStatus, String> {
    let binary_path = resolve_coderabbit_binary(&app);
    if !binary_path.exists() {
        return Ok(CodeRabbitAuthStatus {
            authenticated: false,
            error: Some("CodeRabbit CLI not installed".to_string()),
        });
    }

    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            silent_command(&binary_path)
                .args(["auth", "status", "--agent"])
                .output()
        }),
    )
    .await
    .map_err(|_| "CodeRabbit auth status timed out".to_string())?
    .map_err(|e| format!("Failed to join auth status task: {e}"))?
    .map_err(|e| format!("Failed to check CodeRabbit auth status: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        let lower = stdout.to_lowercase();
        let authenticated = stdout.lines().any(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|value| {
                    value
                        .get("authenticated")
                        .and_then(|v| v.as_bool())
                        .or_else(|| value.get("loggedIn").and_then(|v| v.as_bool()))
                        .or_else(|| value.get("logged_in").and_then(|v| v.as_bool()))
                })
                .unwrap_or(false)
        }) || lower.contains("authenticated")
            || lower.contains("logged in");
        return Ok(CodeRabbitAuthStatus {
            authenticated: authenticated || stdout.trim().is_empty(),
            error: None,
        });
    }

    Ok(CodeRabbitAuthStatus {
        authenticated: false,
        error: Some(if stderr.is_empty() { stdout } else { stderr }),
    })
}

#[tauri::command]
pub async fn install_coderabbit_cli(app: AppHandle) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        return Err("CodeRabbit CLI install script currently supports macOS and Linux. Install CodeRabbit in WSL or add it to PATH.".to_string());
    }

    let cli_dir = ensure_coderabbit_cli_dir(&app)?;
    emit_progress(
        &app,
        "starting",
        "Preparing CodeRabbit CLI installation...",
        0,
    );
    emit_progress(
        &app,
        "downloading",
        "Running official CodeRabbit installer...",
        25,
    );

    let script = "curl -fsSL https://cli.coderabbit.ai/install.sh | sh";
    let output = silent_command("sh")
        .arg("-c")
        .arg(script)
        .env("CODERABBIT_INSTALL_DIR", &cli_dir)
        .output()
        .map_err(|e| format!("Failed to run CodeRabbit installer: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(format!(
            "CodeRabbit installer failed: {}",
            if stderr.is_empty() { stdout } else { stderr }
        ));
    }

    emit_progress(&app, "verifying", "Verifying CodeRabbit CLI...", 85);
    let binary_path = get_coderabbit_binary_path(&app)?;
    if !binary_path.exists() {
        return Err(format!(
            "CodeRabbit installer completed but binary was not found at {}",
            binary_path.display()
        ));
    }

    let verify = silent_command(&binary_path)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to verify CodeRabbit CLI: {e}"))?;
    if !verify.status.success() {
        return Err("CodeRabbit CLI verification failed".to_string());
    }

    emit_progress(&app, "complete", "CodeRabbit CLI installed.", 100);
    Ok(())
}

#[tauri::command]
pub async fn uninstall_coderabbit_cli(app: AppHandle) -> Result<(), String> {
    let cli_dir = get_coderabbit_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove CodeRabbit CLI directory: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn update_coderabbit_cli(app: AppHandle) -> Result<(), String> {
    let binary_path = resolve_coderabbit_binary(&app);
    if !binary_path.exists() {
        return Err("CodeRabbit CLI not installed".to_string());
    }
    let output = silent_command(&binary_path)
        .arg("update")
        .output()
        .map_err(|e| format!("Failed to update CodeRabbit CLI: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        })
    }
}
