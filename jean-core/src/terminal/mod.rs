mod attention;
mod commands;
mod hooks;
mod pty;
mod registry;
mod run_ports;
pub(crate) mod run_supervisor;
mod types;

// Re-export commands for registration in lib.rs
pub use commands::*;
pub use run_supervisor::*;

// Re-export internal functions for app lifecycle cleanup
pub use pty::kill_all_terminals as cleanup_all_terminals;
