//! AI pipeline configuration, stored in an isolated sidecar JSON file
//! (`<app_data>/ai_pipeline/config.json`) so the feature never touches the
//! shared `AppPreferences` / `Project` structs and stays conflict-free on
//! merge-forward.
//!
//! Holds the label the pipeline puts on its PRs (defaults to `ai-full-flow`).
//! PR state itself comes straight from GitHub via `gh` — no dashboard
//! service/credential is involved.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

/// Default label the AI pipeline applies to the PRs it manages.
pub const DEFAULT_PIPELINE_LABEL: &str = "ai-full-flow";

/// Persisted AI pipeline configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiPipelineConfig {
    /// Label the pipeline puts on its PRs. `None` falls back to
    /// [`DEFAULT_PIPELINE_LABEL`]. (Branches following `CU-<id>` are recognized
    /// as pipeline PRs regardless of the label.)
    #[serde(default)]
    pub pipeline_label: Option<String>,
    /// Project the pipeline lists are always scoped to, whatever the entry
    /// point (sidebar, New Session tab, command palette). `None` falls back to
    /// the project the modal was opened from.
    #[serde(default)]
    pub project_id: Option<String>,
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

// =============================================================================
// Tauri commands
// =============================================================================

/// Return the current AI pipeline config.
pub async fn get_ai_pipeline_config(app: AppHandle) -> Result<AiPipelineConfig, String> {
    load_ai_pipeline_config(&app)
}

/// Update the pipeline label. `None`/empty clears it (falls back to the default).
pub async fn set_ai_pipeline_config(
    app: AppHandle,
    pipeline_label: Option<String>,
) -> Result<(), String> {
    let mut config = load_ai_pipeline_config(&app)?;
    config.pipeline_label = pipeline_label.filter(|t| !t.trim().is_empty());
    save_ai_pipeline_config(&app, &config)
}

/// Pin the project the pipeline lists are scoped to. `None`/empty unpins it
/// (the lists then follow the project the modal was opened from). Kept separate
/// from [`set_ai_pipeline_config`] so pinning never clobbers the label.
pub async fn set_ai_pipeline_project(
    app: AppHandle,
    project_id: Option<String>,
) -> Result<(), String> {
    let mut config = load_ai_pipeline_config(&app)?;
    config.project_id = project_id.filter(|t| !t.trim().is_empty());
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
            pipeline_label: Some("my-label".to_string()),
            ..Default::default()
        };
        assert_eq!(cfg.effective_label(), "my-label");
    }

    #[test]
    fn effective_label_ignores_blank() {
        let cfg = AiPipelineConfig {
            pipeline_label: Some("   ".to_string()),
            ..Default::default()
        };
        assert_eq!(cfg.effective_label(), DEFAULT_PIPELINE_LABEL);
    }

    /// A config file written before the pinned-project field existed must still
    /// load (the feature ships to an app that already has a sidecar on disk).
    #[test]
    fn config_without_project_id_still_parses() {
        let cfg: AiPipelineConfig =
            serde_json::from_str(r#"{"pipelineLabel":"ai-full-flow"}"#).unwrap();
        assert_eq!(cfg.project_id, None);
        assert_eq!(cfg.effective_label(), "ai-full-flow");
    }
}
