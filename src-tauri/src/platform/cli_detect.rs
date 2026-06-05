//! Shared CLI path detection that transparently handles WSL mode.
//!
//! In WSL mode, every CLI (`claude`, `codex`, `opencode`, `gh`, `cursor-agent`)
//! must be detected inside the WSL distro — Windows-side `where` returns paths
//! bash cannot exec. Non-WSL paths use the existing native `where`/`which` lookup.

use std::path::{Path, PathBuf};

use super::{detect_package_manager, silent_command};

/// Generic CLI detection result. Per-CLI Tauri commands map this into their
/// typed wrapper structs to keep the wire protocol stable.
#[derive(Debug, Clone)]
pub struct CliDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

impl CliDetection {
    pub fn not_found() -> Self {
        Self {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        }
    }
}

/// Detect a CLI tool on the user's PATH.
///
/// - When WSL mode is enabled: resolves the Unix path inside the WSL distro.
///   Version comes from the selected path's `--version` inside WSL.
/// - Otherwise: runs Windows `where` / Unix `which` and returns the native path.
///   `jean_managed` (when provided) is the canonical path of a Jean-installed
///   binary that must be excluded from "found in PATH" detection.
///   In WSL mode, `jean_managed_wsl` is the Unix path of the Jean-managed
///   binary to exclude from WSL PATH detection.
pub fn detect_cli_in_path(
    tool: &str,
    jean_managed: Option<&Path>,
    jean_managed_wsl: Option<&str>,
) -> CliDetection {
    let wsl = super::get_wsl_config();
    if wsl.enabled {
        let Some(unix_path) = super::wsl_which(&wsl.distro, tool, jean_managed_wsl) else {
            return CliDetection::not_found();
        };
        let version = super::wsl_tool_version(&wsl.distro, &unix_path);
        let package_manager = super::wsl_detect_package_manager(&unix_path);
        return CliDetection {
            found: true,
            path: Some(unix_path),
            version,
            package_manager,
        };
    }

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = match silent_command(which_cmd).arg(tool).output() {
        Ok(o) if o.status.success() => o,
        _ => return CliDetection::not_found(),
    };

    let found = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if found.is_empty() {
        return CliDetection::not_found();
    }

    let found_path = PathBuf::from(&found);

    if let Some(jean_path) = jean_managed {
        if let Ok(canonical_found) = std::fs::canonicalize(&found_path) {
            if canonical_found == jean_path {
                return CliDetection::not_found();
            }
        }
    }

    let version = match silent_command(&found_path).arg("--version").output() {
        Ok(ver_output) if ver_output.status.success() => Some(
            String::from_utf8_lossy(&ver_output.stdout)
                .trim()
                .to_string(),
        ),
        _ => None,
    };

    CliDetection {
        found: true,
        path: Some(found),
        version,
        package_manager: detect_package_manager(&found_path),
    }
}

#[cfg(test)]
mod tests {
    use super::super::wsl_detect_package_manager;

    #[test]
    fn wsl_pkg_mgr_homebrew() {
        assert_eq!(
            wsl_detect_package_manager("/home/linuxbrew/.linuxbrew/bin/gh"),
            Some("homebrew".to_string())
        );
    }

    #[test]
    fn wsl_pkg_mgr_bun() {
        assert_eq!(
            wsl_detect_package_manager(
                "/home/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js"
            ),
            Some("bun".to_string())
        );
    }

    #[test]
    fn wsl_pkg_mgr_npm() {
        assert_eq!(
            wsl_detect_package_manager(
                "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude"
            ),
            Some("npm".to_string())
        );
    }

    #[test]
    fn wsl_pkg_mgr_cargo() {
        assert_eq!(
            wsl_detect_package_manager("/home/u/.cargo/bin/foo"),
            Some("cargo".to_string())
        );
    }

    #[test]
    fn wsl_pkg_mgr_system() {
        assert_eq!(wsl_detect_package_manager("/usr/bin/gh"), None);
    }
}
