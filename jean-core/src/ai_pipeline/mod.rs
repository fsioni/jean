//! AI pipeline PR lifecycle (feature perso).
//!
//! Isolated, self-contained module so merge-forwards from upstream stay cheap.
//! See `docs/superpowers/specs/2026-06-22-ai-pipeline-pr-lifecycle-design.md`.
//!
//! The external AI pipeline (`ai-full-flow`) pushes PRs to GitHub. This module
//! lets Jean:
//!   - list those PRs (read straight from GitHub via `gh pr list`), scoped to
//!     the current project's repo, and resume one (create a worktree +
//!     self-assign on both the ClickUp task and the GitHub PR);
//!   - finish one in a single action (ClickUp status → `to deploy` + merge PR).
//!
//! PR state (CI, draft, mergeable) comes from GitHub directly — no extra
//! dashboard service or credential beyond the `gh` auth Jean already has.
//!
//! Layout:
//! - `config` — sidecar config (`<app_data>/ai_pipeline/config.json`): just the
//!   pipeline label. Never touches `AppPreferences` / `Project`.
//! - `commands` — Tauri commands (list/resume/finish + config get/set).

pub mod commands;
pub mod config;

// Glob re-export so the command handlers stay reachable from the core
// dispatcher (same pattern as `projects::*` and `jenkins::*`).
pub use commands::*;
pub use config::*;
