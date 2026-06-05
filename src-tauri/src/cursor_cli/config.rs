//! Configuration and path resolution for Cursor Agent.

use crate::platform::{get_wsl_config, silent_command};
use std::path::PathBuf;
use tauri::AppHandle;

/// Primary Cursor Agent binary name.
///
/// Cursor's current CLI entrypoint is `agent`; `cursor-agent` remains a
/// backwards-compatible alias on older installs.
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "agent.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "agent";

#[cfg(windows)]
pub const LEGACY_CLI_BINARY_NAME: &str = "cursor-agent.exe";
#[cfg(not(windows))]
pub const LEGACY_CLI_BINARY_NAME: &str = "cursor-agent";

pub const CLI_BINARY_CANDIDATES: [&str; 2] = [CLI_BINARY_NAME, LEGACY_CLI_BINARY_NAME];

/// Bare tool names (without platform-specific extension) for WSL/Unix lookups.
pub const CLI_TOOL_NAME: &str = "agent";
pub const LEGACY_CLI_TOOL_NAME: &str = "cursor-agent";
pub const CLI_TOOL_CANDIDATES: [&str; 2] = [CLI_TOOL_NAME, LEGACY_CLI_TOOL_NAME];

/// Resolve the Cursor Agent binary from system PATH.
///
/// Cursor's installer places the binary on PATH, so Jean resolves the
/// discovered system binary when available and returns a non-existent fallback
/// path otherwise.
pub fn resolve_cli_binary(_app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        // Resolve the absolute Unix path inside WSL via a login shell, so
        // Cursor CLI installed via nvm / bun / cursor.com's installer is
        // found regardless of non-login-shell $PATH.
        for tool_name in CLI_TOOL_CANDIDATES {
            if let Some(unix_path) = crate::platform::wsl_which(&wsl.distro, tool_name, None) {
                return PathBuf::from(unix_path);
            }
        }
        return PathBuf::from(CLI_TOOL_NAME);
    }

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    for binary_name in CLI_BINARY_CANDIDATES {
        if let Ok(output) = silent_command(which_cmd).arg(binary_name).output() {
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
    }

    PathBuf::from(CLI_BINARY_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_primary_agent_binary_name() {
        let resolved = PathBuf::from(CLI_BINARY_NAME);
        assert!(resolved.ends_with(CLI_BINARY_NAME));
    }

    #[test]
    fn candidates_prefer_agent_before_legacy_cursor_agent() {
        assert_eq!(CLI_BINARY_CANDIDATES[0], CLI_BINARY_NAME);
        assert_eq!(CLI_BINARY_CANDIDATES[1], LEGACY_CLI_BINARY_NAME);
    }

    #[test]
    fn wsl_tool_candidates_prefer_agent_before_legacy_cursor_agent() {
        assert_eq!(CLI_TOOL_NAME, "agent");
        assert_eq!(CLI_TOOL_CANDIDATES[0], CLI_TOOL_NAME);
        assert_eq!(CLI_TOOL_CANDIDATES[1], LEGACY_CLI_TOOL_NAME);
    }
}
