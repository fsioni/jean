//! Jenkins integration (feature perso/jenkins).
//!
//! Isolated, self-contained module so merge-forwards from upstream stay cheap.
//! See `docs/superpowers/specs/2026-06-18-jenkins-integration-design.md`.
//!
//! Layout:
//! - `types`     — data structures returned to the frontend (camelCase serde).
//! - `parse`     — pure parsing of the Jenkins REST/wfapi JSON (unit-tested).
//! - `config`    — per-project URL + credentials resolution.
//! - `client`    — thin async HTTP client over the Jenkins REST API.
//! - `freshness` — preview-vs-PR-head comparison (commit freshness).
//! - `gh_checks` — GitHub commit-status fallback (Jenkins rotates builds fast).
//! - `commands`  — Tauri commands (status, re-run, restart, save config).
//! - `poller`    — background loop: notifications + `jenkins:status-update` events.

pub mod client;
pub mod commands;
pub mod config;
pub mod freshness;
pub mod gh_checks;
pub mod parse;
pub mod poller;
pub mod types;

// Glob re-export so `#[tauri::command]`'s hidden `__cmd__*` macros are visible
// to `generate_handler!` (same pattern as `projects::*`).
pub use commands::*;
pub use poller::{start_poller, JenkinsPollSignal};
