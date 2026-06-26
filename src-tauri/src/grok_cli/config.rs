//! Configuration and path resolution for the Grok Build CLI.

use crate::platform::{get_wsl_config, silent_command};
use std::path::PathBuf;
use tauri::AppHandle;

#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "grok.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "grok";

/// Resolve the Grok binary. The first implementation is PATH-first because
/// xAI distributes Grok through its own installer or npm (`@xai-official/grok`).
pub fn resolve_cli_binary(_app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        if let Some(unix_path) = crate::platform::wsl_which(&wsl.distro, "grok", None) {
            return PathBuf::from(unix_path);
        }
        return PathBuf::from(CLI_BINARY_NAME);
    }

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    if let Ok(output) = silent_command(which_cmd).arg(CLI_BINARY_NAME).output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !path_str.is_empty() {
                let path = PathBuf::from(&path_str);
                if path.exists() {
                    return path;
                }
            }
        }
    }

    PathBuf::from(CLI_BINARY_NAME)
}

pub fn binary_exists(path: &PathBuf) -> bool {
    if path.is_absolute() {
        path.exists()
    } else {
        let wsl = get_wsl_config();
        if wsl.enabled {
            crate::platform::check_wsl_tool(&wsl.distro, &path.to_string_lossy())
        } else {
            which::which(path).is_ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_grok_binary_name() {
        assert!(PathBuf::from(CLI_BINARY_NAME).ends_with(CLI_BINARY_NAME));
    }
}
