//! AI pipeline configuration, stored in an isolated sidecar JSON file
//! (`<app_data>/ai_pipeline/config.json`) so the feature never touches the
//! shared `AppPreferences` / `Project` structs and stays conflict-free on
//! merge-forward.
//!
//! Holds the internal dashboard base URL (never hardcoded — public fork) and the
//! label the pipeline puts on its PRs (defaults to `ai-full-flow`).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Default label the AI pipeline applies to the PRs it manages.
pub const DEFAULT_PIPELINE_LABEL: &str = "ai-full-flow";

/// Persisted AI pipeline configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiPipelineConfig {
    /// Dashboard base URL, e.g. `https://ai-agents.example.internal` (no
    /// trailing slash needed). `None` until the user configures it in Settings.
    #[serde(default)]
    pub dashboard_url: Option<String>,
    /// Label the pipeline puts on its PRs. `None` falls back to
    /// [`DEFAULT_PIPELINE_LABEL`].
    #[serde(default)]
    pub pipeline_label: Option<String>,
}

impl AiPipelineConfig {
    /// The effective pipeline label (configured value or the default).
    pub fn effective_label(&self) -> String {
        self.pipeline_label
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_PIPELINE_LABEL)
            .to_string()
    }
}

/// Directory holding the AI pipeline sidecar files.
pub fn get_ai_pipeline_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?
        .join("ai_pipeline");
    Ok(dir)
}

/// Load a JSON sidecar file, returning `T::default()` when the file is absent.
fn load_sidecar<T: DeserializeOwned + Default>(
    app: &AppHandle,
    filename: &str,
) -> Result<T, String> {
    let path: PathBuf = get_ai_pipeline_dir(app)?.join(filename);
    if !path.exists() {
        return Ok(T::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read AI pipeline {filename}: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse AI pipeline {filename}: {e}"))
}

/// Persist a value as a JSON sidecar file (creating the directory).
fn save_sidecar<T: Serialize>(app: &AppHandle, filename: &str, value: &T) -> Result<(), String> {
    let dir = get_ai_pipeline_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create AI pipeline directory: {e}"))?;
    let content = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize AI pipeline {filename}: {e}"))?;
    std::fs::write(dir.join(filename), content)
        .map_err(|e| format!("Failed to write AI pipeline {filename}: {e}"))
}

/// Load the AI pipeline config from disk, returning defaults when absent.
pub fn load_ai_pipeline_config(app: &AppHandle) -> Result<AiPipelineConfig, String> {
    load_sidecar(app, "config.json")
}

/// Persist the AI pipeline config to disk.
pub fn save_ai_pipeline_config(app: &AppHandle, config: &AiPipelineConfig) -> Result<(), String> {
    save_sidecar(app, "config.json", config)
}

/// Resolve the configured dashboard base URL (trimmed, no trailing slash), or an
/// error when it isn't configured yet.
pub fn resolve_dashboard_url(config: &AiPipelineConfig) -> Result<String, String> {
    config
        .dashboard_url
        .as_ref()
        .map(|s| s.trim().trim_end_matches('/'))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            "No AI pipeline dashboard URL configured. Add one in Settings → Integrations."
                .to_string()
        })
}

// =============================================================================
// Tauri commands
// =============================================================================

/// Return the current AI pipeline config.
#[tauri::command]
pub async fn get_ai_pipeline_config(app: AppHandle) -> Result<AiPipelineConfig, String> {
    load_ai_pipeline_config(&app)
}

/// Update the dashboard URL and pipeline label. `None`/empty clears a value.
#[tauri::command]
pub async fn set_ai_pipeline_config(
    app: AppHandle,
    dashboard_url: Option<String>,
    pipeline_label: Option<String>,
) -> Result<(), String> {
    let mut config = load_ai_pipeline_config(&app)?;
    config.dashboard_url = dashboard_url.filter(|t| !t.trim().is_empty());
    config.pipeline_label = pipeline_label.filter(|t| !t.trim().is_empty());
    save_ai_pipeline_config(&app, &config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_label_defaults_when_unset() {
        let cfg = AiPipelineConfig::default();
        assert_eq!(cfg.effective_label(), DEFAULT_PIPELINE_LABEL);
    }

    #[test]
    fn effective_label_uses_configured_value() {
        let cfg = AiPipelineConfig {
            dashboard_url: None,
            pipeline_label: Some("my-label".to_string()),
        };
        assert_eq!(cfg.effective_label(), "my-label");
    }

    #[test]
    fn effective_label_ignores_blank() {
        let cfg = AiPipelineConfig {
            dashboard_url: None,
            pipeline_label: Some("   ".to_string()),
        };
        assert_eq!(cfg.effective_label(), DEFAULT_PIPELINE_LABEL);
    }

    #[test]
    fn resolve_dashboard_url_trims_trailing_slash() {
        let cfg = AiPipelineConfig {
            dashboard_url: Some("https://example.test/ ".to_string()),
            pipeline_label: None,
        };
        assert_eq!(resolve_dashboard_url(&cfg).unwrap(), "https://example.test");
    }

    #[test]
    fn resolve_dashboard_url_errors_when_unset() {
        let cfg = AiPipelineConfig::default();
        assert!(resolve_dashboard_url(&cfg).is_err());
    }

    #[test]
    fn resolve_dashboard_url_errors_when_blank() {
        let cfg = AiPipelineConfig {
            dashboard_url: Some("   ".to_string()),
            pipeline_label: None,
        };
        assert!(resolve_dashboard_url(&cfg).is_err());
    }
}
