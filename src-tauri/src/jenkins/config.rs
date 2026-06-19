//! Per-project Jenkins configuration (URL + credentials).
//!
//! Stored on `Project` (snake_case persisted fields), mirroring the Linear
//! integration. Never hardcode the URL/token — always resolve from here.

use tauri::AppHandle;

use crate::projects::storage::load_projects_data;
use crate::projects::types::Project;

/// Resolved, non-empty Jenkins connection settings for a project.
pub struct JenkinsConfig {
    pub url: String,
    pub user: String,
    pub token: String,
}

/// Build a config from a project, or `Err` if any field is missing/blank.
///
/// The "not configured" wording is matched by the frontend to stay silent, so
/// keep that substring stable.
pub fn config_from_project(project: &Project) -> Result<JenkinsConfig, String> {
    let url = trimmed(project.jenkins_url.as_deref());
    let user = trimmed(project.jenkins_user.as_deref());
    let token = trimmed(project.jenkins_token.as_deref());

    match (url, user, token) {
        (Some(url), Some(user), Some(token)) => Ok(JenkinsConfig { url, user, token }),
        _ => Err("Jenkins not configured for this project".to_string()),
    }
}

/// Load the project from storage and resolve its Jenkins config.
pub fn load_config(app: &AppHandle, project_id: &str) -> Result<JenkinsConfig, String> {
    let data = load_projects_data(app)?;
    let project = data
        .find_project(project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    config_from_project(project)
}

fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
