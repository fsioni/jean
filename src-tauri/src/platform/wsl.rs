//! WSL (Windows Subsystem for Linux) support
//!
//! When WSL mode is enabled, all subprocess execution is routed through `wsl.exe`
//! with proper path translation. Native Windows remains the default.

use std::process::Command;
use std::sync::{OnceLock, RwLock};

use super::silent_command;

/// Cached WSL configuration, initialized at app startup from preferences.
static WSL_CONFIG: OnceLock<RwLock<WslConfig>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct WslConfig {
    pub enabled: bool,
    pub distro: String,
}

impl Default for WslConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            distro: String::new(),
        }
    }
}

/// Initialize the WSL config cache from app preferences.
/// Called once at app startup.
pub fn init_wsl_config(enabled: bool, distro: String) {
    let config = WslConfig { enabled, distro };
    let lock = WSL_CONFIG.get_or_init(|| RwLock::new(WslConfig::default()));
    if let Ok(mut w) = lock.write() {
        *w = config;
    }
}

/// Read the current WSL config (cheap clone).
pub fn get_wsl_config() -> WslConfig {
    WSL_CONFIG
        .get()
        .and_then(|lock| lock.read().ok().map(|r| r.clone()))
        .unwrap_or_default()
}

/// Update WSL config at runtime (e.g., when preferences change).
pub fn update_wsl_config(enabled: bool, distro: String) {
    if let Some(lock) = WSL_CONFIG.get() {
        if let Ok(mut w) = lock.write() {
            w.enabled = enabled;
            w.distro = distro;
        }
    }
}

/// Convert a Windows path to a WSL Unix path.
///
/// Handles:
/// - UNC paths: `\\wsl.localhost\Ubuntu\home\user` -> `/home/user`
/// - UNC paths: `\\wsl$\Ubuntu\home\user` -> `/home/user`
/// - Drive paths: `C:\Users\foo` -> `/mnt/c/Users/foo`
pub fn win_to_wsl_path(path: &str) -> String {
    // Normalize backslashes
    let normalized = path.replace('\\', "/");

    // Handle \\wsl.localhost\Distro\... or \\wsl$\Distro\...
    for prefix in &["//wsl.localhost/", "//wsl$/"] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            // rest = "Ubuntu/home/user/..."
            // Skip the distro name to get the Unix path
            if let Some(slash_pos) = rest.find('/') {
                return rest[slash_pos..].to_string();
            }
            // Path is just the distro root
            return "/".to_string();
        }
    }

    // Handle drive letter paths: C:\... -> /mnt/c/...
    if normalized.len() >= 3
        && normalized.as_bytes()[0].is_ascii_alphabetic()
        && &normalized[1..3] == ":/"
    {
        let drive = (normalized.as_bytes()[0] as char).to_ascii_lowercase();
        return format!("/mnt/{drive}/{}", &normalized[3..]);
    }

    // Already a Unix path or unknown format — return as-is
    normalized
}

/// Convert a WSL Unix path to a Windows UNC path.
///
/// `/home/user` -> `\\wsl.localhost\<distro>\home\user`
pub fn wsl_to_win_path(unix_path: &str, distro: &str) -> String {
    if unix_path.starts_with("/mnt/") && unix_path.len() >= 6 {
        // /mnt/c/Users/foo -> C:\Users\foo
        let drive = (unix_path.as_bytes()[5] as char).to_ascii_uppercase();
        let rest = if unix_path.len() > 6 {
            &unix_path[6..]
        } else {
            "\\"
        };
        return format!("{drive}:{}", rest.replace('/', "\\"));
    }

    format!(
        "\\\\wsl.localhost\\{distro}{}",
        unix_path.replace('/', "\\")
    )
}

/// Create a Command that routes through WSL when enabled.
///
/// On non-Windows or when WSL is disabled, this is equivalent to `silent_command(program)`
/// with an optional `current_dir`.
pub fn wsl_aware_command(program: &str, cwd: Option<&std::path::Path>) -> Command {
    let config = get_wsl_config();

    if !config.enabled {
        let mut cmd = silent_command(program);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        return cmd;
    }

    // Route through wsl.exe
    let mut cmd = silent_command("wsl.exe");
    let mut args = vec!["-d".to_string(), config.distro.clone()];

    if let Some(dir) = cwd {
        let dir_str = dir.to_string_lossy();
        let unix_path = win_to_wsl_path(&dir_str);
        args.extend(["--cd".to_string(), unix_path]);
    }

    args.extend(["--".to_string(), program.to_string()]);
    cmd.args(&args);
    cmd
}

/// Check if WSL is available on this system.
#[cfg(windows)]
pub fn is_wsl_available() -> bool {
    silent_command("wsl.exe")
        .arg("--status")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn is_wsl_available() -> bool {
    false
}

/// List available WSL distributions.
#[cfg(windows)]
pub fn list_wsl_distros() -> Vec<String> {
    let output = match silent_command("wsl.exe").args(["-l", "-q"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };

    // wsl -l -q on Windows outputs UTF-16LE
    let stdout = &output.stdout;
    let text = if stdout.len() >= 2 && stdout[0] == 0xFF && stdout[1] == 0xFE {
        // UTF-16LE BOM
        decode_utf16le(&stdout[2..])
    } else if stdout.iter().any(|&b| b == 0) {
        // No BOM but has null bytes — likely UTF-16LE
        decode_utf16le(stdout)
    } else {
        String::from_utf8_lossy(stdout).to_string()
    };

    text.lines()
        .map(|l| l.trim().trim_matches('\0'))
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

#[cfg(not(windows))]
pub fn list_wsl_distros() -> Vec<String> {
    vec![]
}

/// Decode a byte slice as UTF-16LE to a String.
fn decode_utf16le(bytes: &[u8]) -> String {
    let u16s: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    String::from_utf16_lossy(&u16s)
}

/// Check if a tool exists inside a WSL distro.
///
/// Uses a login shell (`bash -lc`) so `$PATH` modifications from `~/.profile`,
/// `~/.bash_profile`, and (via Ubuntu's default `.profile`) `~/.bashrc`
/// are applied. Without this, tools installed via nvm / bun / volta / npm
/// global (which modify PATH in rc files) appear "not installed".
#[cfg(windows)]
pub fn check_wsl_tool(distro: &str, tool: &str) -> bool {
    let script = format!("command -v {} >/dev/null 2>&1", shell_single_quote(tool));
    silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn check_wsl_tool(_distro: &str, _tool: &str) -> bool {
    false
}

/// Resolve the Unix path of a tool inside a WSL distro via `command -v`
/// in a login shell.
#[cfg(windows)]
pub fn wsl_which(distro: &str, tool: &str) -> Option<String> {
    let script = format!("command -v {}", shell_single_quote(tool));
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(windows))]
pub fn wsl_which(_distro: &str, _tool: &str) -> Option<String> {
    None
}

/// Get the `--version` output of a tool inside a WSL distro.
///
/// Runs the command in a login shell so rc-file `$PATH` additions apply.
/// If `tool` is an absolute path it executes directly regardless of PATH.
#[cfg(windows)]
pub fn wsl_tool_version(distro: &str, tool: &str) -> Option<String> {
    let script = format!("{} --version", shell_single_quote(tool));
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if ver.is_empty() {
        None
    } else {
        Some(ver)
    }
}

#[cfg(not(windows))]
pub fn wsl_tool_version(_distro: &str, _tool: &str) -> Option<String> {
    None
}

/// Detect the package manager for a tool installed inside WSL, based on its Unix path.
/// Pure string inspection — no process spawn.
pub fn wsl_detect_package_manager(unix_path: &str) -> Option<String> {
    if unix_path.contains("/homebrew/") || unix_path.contains("/linuxbrew/") {
        return Some("homebrew".to_string());
    }
    if unix_path.contains("/.bun/") {
        return Some("bun".to_string());
    }
    if unix_path.contains("/node_modules/") || unix_path.contains("/.npm/") {
        return Some("npm".to_string());
    }
    if unix_path.contains("/.cargo/") {
        return Some("cargo".to_string());
    }
    None
}

/// Detect the CPU architecture inside a WSL distro.
/// Returns the key used by the Claude distribution manifest
/// (`"linux-x64"` / `"linux-arm64"`), or `None` if unsupported.
#[cfg(windows)]
pub fn wsl_detect_arch(distro: &str) -> Option<&'static str> {
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "uname", "-m"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let arch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match arch.as_str() {
        "x86_64" | "amd64" => Some("linux-x64"),
        "aarch64" | "arm64" => Some("linux-arm64"),
        _ => None,
    }
}

#[cfg(not(windows))]
pub fn wsl_detect_arch(_distro: &str) -> Option<&'static str> {
    None
}

/// Shell-escape a string for use inside single-quoted bash.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Write `bytes` to `unix_path` inside a WSL distro.
/// Creates any missing parent directories. Transfers bytes via stdin into
/// `bash -c "mkdir -p <dir> && cat > <path>"` so no intermediate file is
/// required on the Windows side.
#[cfg(windows)]
pub fn wsl_write_bytes(distro: &str, unix_path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let dir = unix_path.rfind('/').map(|i| &unix_path[..i]).unwrap_or("/");
    let script = format!(
        "mkdir -p {dir_q} && cat > {path_q}",
        dir_q = shell_single_quote(dir),
        path_q = shell_single_quote(unix_path),
    );

    let mut child = silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-c", &script])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn wsl.exe: {e}"))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "Failed to open wsl.exe stdin".to_string())?;
        stdin
            .write_all(bytes)
            .map_err(|e| format!("Failed to stream bytes into WSL: {e}"))?;
    }

    let status = child
        .wait()
        .map_err(|e| format!("wsl.exe did not exit cleanly: {e}"))?;
    if !status.success() {
        return Err(format!(
            "Failed to write file inside WSL (exit {status})"
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn wsl_write_bytes(_distro: &str, _unix_path: &str, _bytes: &[u8]) -> Result<(), String> {
    Err("WSL is not available on this platform".to_string())
}

/// Make a file executable (chmod +x) inside a WSL distro.
#[cfg(windows)]
pub fn wsl_chmod_exec(distro: &str, unix_path: &str) -> Result<(), String> {
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "chmod", "+x", unix_path])
        .output()
        .map_err(|e| format!("Failed to run wsl.exe chmod: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("chmod failed inside WSL: {stderr}"));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn wsl_chmod_exec(_distro: &str, _unix_path: &str) -> Result<(), String> {
    Err("WSL is not available on this platform".to_string())
}

/// Check that a file exists and is executable inside a WSL distro.
#[cfg(windows)]
pub fn wsl_file_executable(distro: &str, unix_path: &str) -> bool {
    silent_command("wsl.exe")
        .args(["-d", distro, "--", "test", "-x", unix_path])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn wsl_file_executable(_distro: &str, _unix_path: &str) -> bool {
    false
}

/// Get the home directory inside a WSL distro.
#[cfg(windows)]
pub fn get_wsl_home_dir(distro: &str) -> Result<String, String> {
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "sh", "-c", "echo $HOME"])
        .output()
        .map_err(|e| format!("Failed to run wsl.exe: {e}"))?;

    if !output.status.success() {
        return Err("Failed to get WSL home directory".to_string());
    }

    let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if home.is_empty() {
        return Err("WSL home directory is empty".to_string());
    }
    Ok(home)
}

#[cfg(not(windows))]
pub fn get_wsl_home_dir(_distro: &str) -> Result<String, String> {
    Err("WSL is not available on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_win_to_wsl_path_unc_localhost() {
        assert_eq!(
            win_to_wsl_path(r"\\wsl.localhost\Ubuntu\home\user\project"),
            "/home/user/project"
        );
    }

    #[test]
    fn test_win_to_wsl_path_unc_wsl_dollar() {
        assert_eq!(
            win_to_wsl_path(r"\\wsl$\Ubuntu\home\user"),
            "/home/user"
        );
    }

    #[test]
    fn test_win_to_wsl_path_drive_letter() {
        assert_eq!(
            win_to_wsl_path(r"C:\Users\foo\project"),
            "/mnt/c/Users/foo/project"
        );
    }

    #[test]
    fn test_win_to_wsl_path_unix_passthrough() {
        assert_eq!(win_to_wsl_path("/home/user"), "/home/user");
    }

    #[test]
    fn test_wsl_to_win_path_home() {
        assert_eq!(
            wsl_to_win_path("/home/user/project", "Ubuntu"),
            r"\\wsl.localhost\Ubuntu\home\user\project"
        );
    }

    #[test]
    fn test_wsl_to_win_path_mnt() {
        assert_eq!(
            wsl_to_win_path("/mnt/c/Users/foo", "Ubuntu"),
            r"C:\Users\foo"
        );
    }

    #[test]
    fn test_wsl_aware_command_disabled() {
        // With default (disabled) config, should behave like silent_command
        let cmd = wsl_aware_command("git", Some(std::path::Path::new("/tmp")));
        let program = format!("{:?}", cmd.get_program());
        assert!(program.contains("git"));
    }

    #[test]
    fn test_decode_utf16le() {
        let input = "Ubuntu\0".encode_utf16().flat_map(|c| c.to_le_bytes()).collect::<Vec<_>>();
        let result = decode_utf16le(&input);
        assert!(result.contains("Ubuntu"));
    }
}
