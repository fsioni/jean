//! Command Code CLI execution engine.
//!
//! Uses documented headless mode (`cmd -p`) which is final-output-only and has
//! standalone session scope. Jean injects transcript/context into the prompt and
//! emits one synthetic final chunk for frontend compatibility.

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use tauri::AppHandle;

const DEFAULT_MAX_TURNS: &str = "30";
const JEAN_PLAN_OPEN: &str = "<jean-plan>";
const JEAN_PLAN_CLOSE: &str = "</jean-plan>";
const COMMANDCODE_PLAN_CONTRACT: &str = r#"<commandcode_plan_contract>
Jean runs Command Code headlessly, so native interactive plan-exit callbacks are unavailable.
- For normal answers, questions, greetings, and analysis that is not ready for implementation approval: respond normally.
- When you have a concrete implementation plan that should pause for Jean's Approve/YOLO controls: wrap only that plan in <jean-plan>...</jean-plan>.
- Do not call exit_plan_mode in this headless integration.
</commandcode_plan_contract>"#;

#[derive(serde::Serialize, Clone)]
struct ChunkEvent {
    session_id: String,
    worktree_id: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct DoneEvent {
    session_id: String,
    worktree_id: String,
    waiting_for_plan: bool,
}

pub struct CommandCodeResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub waiting_for_plan: bool,
    pub usage: Option<UsageData>,
}

struct ParsedCommandCodeOutput {
    content: String,
    waiting_for_plan: bool,
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek().is_some_and(|c| *c == '[') {
                let _ = chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn commandcode_error_for_status(code: Option<i32>, stderr: &str) -> String {
    let base = match code {
        Some(3) => "Command Code is not authenticated. Run `cmd login`.",
        Some(4) => "Command Code denied a requested permission.",
        Some(5) => "Command Code rate limit exceeded.",
        Some(6) => "Command Code network failure.",
        Some(7) => "Command Code API server error.",
        Some(130) => "Command Code run interrupted.",
        _ => "Command Code run failed.",
    };
    let stderr = strip_ansi(stderr).trim().to_string();
    if stderr.is_empty() {
        base.to_string()
    } else {
        format!("{base}\n{stderr}")
    }
}

fn parse_commandcode_plan_output(content: &str) -> ParsedCommandCodeOutput {
    let trimmed = content.trim();
    let Some(start) = trimmed.find(JEAN_PLAN_OPEN) else {
        return ParsedCommandCodeOutput {
            content: trimmed.to_string(),
            waiting_for_plan: false,
        };
    };
    let plan_start = start + JEAN_PLAN_OPEN.len();
    let Some(relative_end) = trimmed[plan_start..].find(JEAN_PLAN_CLOSE) else {
        return ParsedCommandCodeOutput {
            content: trimmed.to_string(),
            waiting_for_plan: false,
        };
    };
    let end = plan_start + relative_end;
    ParsedCommandCodeOutput {
        content: trimmed[plan_start..end].trim().to_string(),
        waiting_for_plan: true,
    }
}

fn build_prompt(system_context: Option<&str>, message: &str, mode: &str) -> String {
    let mut prompt = String::new();
    if let Some(ctx) = system_context.map(str::trim).filter(|s| !s.is_empty()) {
        prompt.push_str("<jean_context>\n");
        prompt.push_str(ctx);
        prompt.push_str("\n</jean_context>\n\n");
    }
    if mode == "plan" {
        prompt.push_str(COMMANDCODE_PLAN_CONTRACT);
        prompt.push_str("\n\n");
    }
    prompt.push_str(message);
    prompt
}

fn normalize_model_for_cli(model: Option<&str>) -> Option<String> {
    let model = model.map(str::trim).filter(|value| !value.is_empty())?;
    if model == "commandcode/default" || model == "default" {
        return None;
    }
    Some(
        model
            .strip_prefix("commandcode/")
            .unwrap_or(model)
            .to_string(),
    )
}

fn preview_for_log(text: &str) -> String {
    const MAX_CHARS: usize = 2_000;
    let mut preview: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        preview.push_str("…");
    }
    preview.replace('\n', "\\n")
}

pub fn execute_commandcode_headless(
    app: &AppHandle,
    jean_session_id: &str,
    worktree_id: &str,
    run_id: &str,
    working_dir: &Path,
    execution_mode: Option<&str>,
    model: Option<&str>,
    message: &str,
    system_context: Option<&str>,
    pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
) -> Result<(u32, CommandCodeResponse), String> {
    let binary_path = crate::commandcode_cli::resolve_cli_binary(app);
    if !binary_path.exists() {
        log::warn!(
            "Command Code CLI not found for session={} worktree={} resolved_path={}",
            jean_session_id,
            worktree_id,
            binary_path.display()
        );
        return Err("Command Code CLI not found. Install it with `npm install -g command-code` and run `cmd login`.".to_string());
    }

    let mode = execution_mode.unwrap_or("plan");
    log::info!(
        "Starting Command Code headless run session={} worktree={} mode={} binary={} cwd={} streaming=false",
        jean_session_id,
        worktree_id,
        mode,
        binary_path.display(),
        working_dir.display()
    );
    log::debug!(
        "Command Code prompt inputs session={} message_bytes={} system_context_bytes={} selected_model={:?}",
        jean_session_id,
        message.len(),
        system_context.map(str::len).unwrap_or(0),
        model
    );

    let mut command =
        crate::platform::cli_command(&binary_path.to_string_lossy(), Some(working_dir));
    command
        .arg("-p")
        .arg("--trust")
        .arg("--skip-onboarding")
        .arg("--max-turns")
        .arg(DEFAULT_MAX_TURNS);
    let cli_model = normalize_model_for_cli(model);
    if let Some(cli_model) = &cli_model {
        command.arg("--model").arg(cli_model);
        log::info!(
            "Command Code run session={} using --model {} max_turns={}",
            jean_session_id,
            cli_model,
            DEFAULT_MAX_TURNS
        );
    }
    match mode {
        "yolo" => {
            command.arg("--yolo");
        }
        "build" => {
            command.arg("--auto-accept");
        }
        _ => {
            command.arg("--permission-mode").arg("plan");
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn Command Code CLI: {e}"))?;
    let pid = child.id();
    log::info!(
        "Spawned Command Code process session={} worktree={} pid={} (output is final-only; waiting for process exit)",
        jean_session_id,
        worktree_id,
        pid
    );
    if let Some(cb) = pid_callback {
        cb(pid);
    }

    if let Some(mut stdin) = child.stdin.take() {
        let prompt = build_prompt(system_context, message, mode);
        log::debug!(
            "Writing Command Code stdin session={} prompt_bytes={} prompt_preview=\"{}\"",
            jean_session_id,
            prompt.len(),
            preview_for_log(&prompt)
        );
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("Failed to write Command Code prompt: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Command Code CLI: {e}"))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));

    log::info!(
        "Command Code process exited session={} worktree={} pid={} success={} code={:?} stdout_bytes={} stderr_bytes={}",
        jean_session_id,
        worktree_id,
        pid,
        output.status.success(),
        output.status.code(),
        stdout.len(),
        stderr.len()
    );
    if !stdout.trim().is_empty() {
        log::debug!(
            "Command Code stdout session={} preview=\"{}\"",
            jean_session_id,
            preview_for_log(stdout.trim())
        );
    }
    if !stderr.trim().is_empty() {
        log::debug!(
            "Command Code stderr session={} preview=\"{}\"",
            jean_session_id,
            preview_for_log(stderr.trim())
        );
    }

    if !output.status.success() && output.status.code() == Some(130) {
        let waiting_for_plan = false;
        match app.emit_all(
            "chat:done",
            &DoneEvent {
                session_id: jean_session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                waiting_for_plan,
            },
        ) {
            Ok(_) => log::debug!(
                "Emitted Command Code cancellation chat:done session={} waiting_for_plan={}",
                jean_session_id,
                waiting_for_plan
            ),
            Err(error) => log::warn!(
                "Failed to emit Command Code cancellation chat:done session={}: {}",
                jean_session_id,
                error
            ),
        }
        return Ok((
            pid,
            CommandCodeResponse {
                content: String::new(),
                session_id: jean_session_id.to_string(),
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: true,
                waiting_for_plan,
                usage: None,
            },
        ));
    }

    if !output.status.success() {
        return Err(commandcode_error_for_status(output.status.code(), &stderr));
    }

    let parsed_output = parse_commandcode_plan_output(stdout.trim());
    let content = parsed_output.content;
    let waiting_for_plan = mode == "plan" && parsed_output.waiting_for_plan;
    if !content.is_empty() {
        match app.emit_all(
            "chat:chunk",
            &ChunkEvent {
                session_id: jean_session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                content: content.clone(),
                run_id: Some(run_id.to_string()),
            },
        ) {
            Ok(_) => log::debug!(
                "Emitted Command Code synthetic chat:chunk session={} bytes={}",
                jean_session_id,
                content.len()
            ),
            Err(error) => log::warn!(
                "Failed to emit Command Code chat:chunk session={}: {}",
                jean_session_id,
                error
            ),
        }
    } else {
        log::warn!(
            "Command Code completed with empty stdout session={} worktree={}",
            jean_session_id,
            worktree_id
        );
    }
    match app.emit_all(
        "chat:done",
        &DoneEvent {
            session_id: jean_session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            waiting_for_plan,
        },
    ) {
        Ok(_) => log::debug!(
            "Emitted Command Code chat:done session={} waiting_for_plan={}",
            jean_session_id,
            waiting_for_plan
        ),
        Err(error) => log::warn!(
            "Failed to emit Command Code chat:done session={}: {}",
            jean_session_id,
            error
        ),
    }

    let content_blocks = if content.is_empty() {
        vec![]
    } else {
        vec![ContentBlock::Text {
            text: content.clone(),
        }]
    };
    Ok((
        pid,
        CommandCodeResponse {
            content,
            session_id: jean_session_id.to_string(),
            tool_calls: vec![],
            content_blocks,
            cancelled: false,
            waiting_for_plan,
            usage: None,
        },
    ))
}

pub fn execute_one_shot_commandcode(
    app: &AppHandle,
    prompt: &str,
    working_dir: Option<&str>,
    execution_mode: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    let binary_path = crate::commandcode_cli::resolve_cli_binary(app);
    if !binary_path.exists() {
        log::warn!(
            "Command Code CLI not found for one-shot resolved_path={}",
            binary_path.display()
        );
        return Err(
            "Command Code CLI not found. Install it with `npm install -g command-code`."
                .to_string(),
        );
    }
    log::info!(
        "Starting Command Code one-shot mode={} binary={} cwd={:?} streaming=false prompt_bytes={} selected_model={:?}",
        execution_mode.unwrap_or("plan"),
        binary_path.display(),
        working_dir,
        prompt.len(),
        model
    );
    let cwd = working_dir.map(Path::new);
    let mut command = crate::platform::cli_command(&binary_path.to_string_lossy(), cwd);
    command
        .arg("-p")
        .arg("--trust")
        .arg("--skip-onboarding")
        .arg("--max-turns")
        .arg(DEFAULT_MAX_TURNS);
    let cli_model = normalize_model_for_cli(model);
    if let Some(cli_model) = &cli_model {
        command.arg("--model").arg(cli_model);
        log::info!("Command Code one-shot using --model {}", cli_model);
    }
    match execution_mode.unwrap_or("plan") {
        "yolo" => {
            command.arg("--yolo");
        }
        "build" => {
            command.arg("--auto-accept");
        }
        _ => {
            command.arg("--permission-mode").arg("plan");
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn Command Code CLI: {e}"))?;
    let pid = child.id();
    log::info!("Spawned Command Code one-shot pid={}", pid);
    if let Some(mut stdin) = child.stdin.take() {
        log::debug!(
            "Writing Command Code one-shot stdin pid={} prompt_preview=\"{}\"",
            pid,
            preview_for_log(prompt)
        );
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("Failed to write Command Code prompt: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Command Code CLI: {e}"))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    log::info!(
        "Command Code one-shot exited pid={} success={} code={:?} stdout_bytes={} stderr_bytes={}",
        pid,
        output.status.success(),
        output.status.code(),
        stdout.len(),
        stderr.len()
    );
    if !stdout.trim().is_empty() {
        log::debug!(
            "Command Code one-shot stdout pid={} preview=\"{}\"",
            pid,
            preview_for_log(stdout.trim())
        );
    }
    if !stderr.trim().is_empty() {
        log::debug!(
            "Command Code one-shot stderr pid={} preview=\"{}\"",
            pid,
            preview_for_log(stderr.trim())
        );
    }
    if !output.status.success() {
        return Err(commandcode_error_for_status(output.status.code(), &stderr));
    }
    Ok(stdout.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commandcode_plan_detection_does_not_wait_for_plain_chat() {
        let output =
            parse_commandcode_plan_output("Doing well, thanks. What are we working on today?");

        assert_eq!(
            output.content,
            "Doing well, thanks. What are we working on today?"
        );
        assert!(!output.waiting_for_plan);
    }

    #[test]
    fn commandcode_plan_detection_waits_for_marked_plan() {
        let output = parse_commandcode_plan_output(
            "I found the issue.\n\n<jean-plan>\n1. Add regression test\n2. Fix parser\n</jean-plan>",
        );

        assert_eq!(output.content, "1. Add regression test\n2. Fix parser");
        assert!(output.waiting_for_plan);
    }

    #[test]
    fn commandcode_plan_prompt_guidance_is_only_added_in_plan_mode() {
        let plan_prompt = build_prompt(Some("context"), "message", "plan");
        assert!(plan_prompt.contains("<commandcode_plan_contract>"));
        assert!(plan_prompt.contains("<jean-plan>"));

        let build_prompt = build_prompt(Some("context"), "message", "build");
        assert!(!build_prompt.contains("<commandcode_plan_contract>"));
    }
}
