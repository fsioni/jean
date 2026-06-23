//! AI pipeline PR lifecycle (feature perso).
//!
//! Isolated, self-contained module so merge-forwards from upstream stay cheap.
//! See `docs/superpowers/specs/2026-06-22-ai-pipeline-pr-lifecycle-design.md`.
//!
//! The external AI pipeline (`ai-full-flow`) pushes PRs to GitHub and tracks
//! them on an internal dashboard. This module lets Jean:
//!   - list those PRs (`GET {dashboard}/prs`), scoped to the current project's
//!     GitHub repo, and resume one (create a worktree + self-assign on both the
//!     ClickUp task and the GitHub PR);
//!   - finish one in a single action (ClickUp status → `to deploy` + merge PR).
//!
//! Layout:
//! - `config` — sidecar config (`<app_data>/ai_pipeline/config.json`): the
//!   dashboard base URL + the pipeline label. Never hardcoded (public fork) and
//!   never touches `AppPreferences` / `Project`.
//! - `client` — thin async HTTP client over the dashboard (`/prs`). Accepts the
//!   internal self-signed cert (same as the Jenkins preview probe).
//! - `commands` — Tauri commands (list/resume/finish + config get/set).

pub mod client;
pub mod commands;
pub mod config;

// Glob re-export so `#[tauri::command]`'s hidden `__cmd__*` macros are visible
// to `generate_handler!` (same pattern as `projects::*` and `jenkins::*`).
pub use commands::*;
pub use config::*;
