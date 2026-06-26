//! Grok Build CLI execution engine.

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use crate::platform::silent_command;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::Stdio;
use tauri::AppHandle;

#[derive(serde::Serialize, Clone)]
struct ChunkEvent {
    session_id: String,
    worktree_id: String,
    content: String,
}

#[derive(serde::Serialize, Clone)]
struct ToolUseEvent {
    session_id: String,
    worktree_id: String,
    id: String,
    name: String,
    input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct ToolBlockEvent {
    session_id: String,
    worktree_id: String,
    tool_call_id: String,
}

#[derive(serde::Serialize, Clone)]
struct ToolResultEvent {
    session_id: String,
    worktree_id: String,
    tool_use_id: String,
    output: String,
}

#[derive(serde::Serialize, Clone)]
pub struct ErrorEvent {
    pub session_id: String,
    pub worktree_id: String,
    pub error: String,
}

pub struct GrokResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
}

#[derive(Debug, Clone)]
struct ParsedToolCall {
    id: String,
    name: String,
    input: Value,
}

const GROK_SYNTHETIC_PLAN_TOOL_NAME: &str = "ExitPlanMode";

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

/// Default Grok model used when no Grok-specific model is supplied.
pub const GROK_DEFAULT_MODEL: &str = "grok-composer-2.5-fast";

fn raw_grok_model(model: Option<&str>) -> Option<&str> {
    match model.map(|value| value.strip_prefix("grok/").unwrap_or(value)) {
        Some("grok-build-0.1") => Some("grok-composer-2.5-fast"),
        Some("grok-composer-2.5-fast") => Some("grok-composer-2.5-fast"),
        value => value,
    }
}

/// Resolve a one-shot Grok model. Magic-prompt callers share a global model
/// string that defaults to a Claude model when none is set; coerce any
/// non-Grok model to the Grok default so the Grok executor never receives a
/// Claude/other-backend model id.
fn resolve_one_shot_grok_model(model: &str) -> &str {
    let stripped = model.strip_prefix("grok/").unwrap_or(model);
    if stripped.starts_with("grok") {
        model
    } else {
        GROK_DEFAULT_MODEL
    }
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn first_string(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths.iter().find_map(|path| {
        value_at_path(value, path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn first_value(value: &Value, paths: &[&[&str]]) -> Option<Value> {
    paths
        .iter()
        .find_map(|path| value_at_path(value, path).cloned())
}

fn extract_session_id(value: &Value) -> Option<String> {
    first_string(
        value,
        &[
            &["session_id"],
            &["sessionId"],
            &["id"],
            &["session", "id"],
            &["result", "session_id"],
            &["result", "sessionId"],
        ],
    )
}

fn extract_usage(value: &Value) -> Option<UsageData> {
    let usage = value
        .get("usage")
        .or_else(|| value_at_path(value, &["result", "usage"]))?;
    let input_tokens = usage
        .get("input_tokens")
        .or_else(|| usage.get("inputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .or_else(|| usage.get("outputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read_input_tokens = usage
        .get("cache_read_input_tokens")
        .or_else(|| usage.get("cacheReadInputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_creation_input_tokens = usage
        .get("cache_creation_input_tokens")
        .or_else(|| usage.get("cacheCreationInputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    if input_tokens == 0
        && output_tokens == 0
        && cache_read_input_tokens == 0
        && cache_creation_input_tokens == 0
    {
        return None;
    }

    Some(UsageData {
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
    })
}

fn extract_text_delta(value: &Value) -> Option<String> {
    [
        &["delta"][..],
        &["text"][..],
        &["content"][..],
        &["message", "delta"][..],
        &["message", "text"][..],
        &["update", "content", "text"][..],
        &["params", "update", "content", "text"][..],
    ]
    .iter()
    .find_map(|path| {
        value_at_path(value, path)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn extract_text_from_block(block: &Value) -> Option<String> {
    if block.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    block
        .get("text")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn extract_message_blocks(value: &Value) -> Option<&Vec<Value>> {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .or_else(|| value.get("content").and_then(Value::as_array))
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("message"))
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
        })
}

fn extract_tool_call_from_block(block: &Value) -> Option<ParsedToolCall> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return None;
    }
    let id = first_string(
        block,
        &[
            &["id"],
            &["tool_call_id"],
            &["toolCallId"],
            &["tool_use_id"],
        ],
    )?;
    let name = first_string(block, &[&["name"], &["tool_name"], &["toolName"]])?;
    let input = first_value(
        block,
        &[&["input"], &["args"], &["arguments"], &["parameters"]],
    )
    .unwrap_or(Value::Null);
    Some(ParsedToolCall { id, name, input })
}

fn extract_tool_call_event(value: &Value) -> Option<ParsedToolCall> {
    let id = first_string(
        value,
        &[
            &["id"],
            &["tool_call_id"],
            &["toolCallId"],
            &["tool_use_id"],
            &["toolUseId"],
            &["call_id"],
        ],
    )?;
    let name = first_string(
        value,
        &[
            &["name"],
            &["tool_name"],
            &["toolName"],
            &["tool", "name"],
            &["tool_call", "name"],
        ],
    )?;
    let input = first_value(
        value,
        &[
            &["input"],
            &["args"],
            &["arguments"],
            &["parameters"],
            &["tool", "input"],
            &["tool_call", "input"],
        ],
    )
    .unwrap_or(Value::Null);
    Some(ParsedToolCall { id, name, input })
}

fn extract_tool_result_event(value: &Value) -> Option<(String, String)> {
    let tool_use_id = first_string(
        value,
        &[
            &["tool_use_id"],
            &["toolUseId"],
            &["tool_call_id"],
            &["toolCallId"],
            &["call_id"],
        ],
    )?;
    let output_value = first_value(
        value,
        &[
            &["output"],
            &["result"],
            &["content"],
            &["text"],
            &["tool_result"],
        ],
    )?;
    let output = match output_value {
        Value::String(text) => text,
        other => other.to_string(),
    };
    Some((tool_use_id, output))
}

fn extract_final_result_text(value: &Value) -> Option<String> {
    match value.get("result") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            first_string(other, &[&["text"], &["content"], &["output_text"]]).or_else(|| {
                value_at_path(other, &["message", "content"])
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter_map(extract_text_from_block)
                            .collect::<String>()
                    })
                    .filter(|text| !text.is_empty())
            })
        }
        None => None,
    }
}

fn push_text_block(content_blocks: &mut Vec<ContentBlock>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(ContentBlock::Text { text: existing }) = content_blocks.last_mut() {
        existing.push_str(text);
        return;
    }
    content_blocks.push(ContentBlock::Text {
        text: text.to_string(),
    });
}

fn ensure_tool_use(content_blocks: &mut Vec<ContentBlock>, tool_call_id: &str) {
    if content_blocks.iter().any(|block| {
        matches!(
            block,
            ContentBlock::ToolUse {
                tool_call_id: existing
            } if existing == tool_call_id
        )
    }) {
        return;
    }
    content_blocks.push(ContentBlock::ToolUse {
        tool_call_id: tool_call_id.to_string(),
    });
}

fn upsert_tool_call(tool_calls: &mut Vec<ToolCall>, parsed: &ParsedToolCall) {
    if let Some(existing) = tool_calls.iter_mut().find(|tool| tool.id == parsed.id) {
        existing.name = parsed.name.clone();
        existing.input = parsed.input.clone();
        return;
    }
    tool_calls.push(ToolCall {
        id: parsed.id.clone(),
        name: parsed.name.clone(),
        input: parsed.input.clone(),
        output: None,
        parent_tool_use_id: None,
    });
}

fn set_tool_result(tool_calls: &mut [ToolCall], tool_use_id: &str, output: &str) {
    if let Some(tool) = tool_calls.iter_mut().find(|tool| tool.id == tool_use_id) {
        tool.output = Some(output.to_string());
    }
}

fn process_message_blocks<ChunkFn, ToolUseFn>(
    blocks: &[Value],
    content: &mut String,
    content_blocks: &mut Vec<ContentBlock>,
    tool_calls: &mut Vec<ToolCall>,
    on_chunk: &mut ChunkFn,
    on_tool_use: &mut ToolUseFn,
) where
    ChunkFn: FnMut(&str),
    ToolUseFn: FnMut(&ParsedToolCall),
{
    for block in blocks {
        if let Some(text) = extract_text_from_block(block) {
            content.push_str(&text);
            push_text_block(content_blocks, &text);
            on_chunk(&text);
            continue;
        }
        if let Some(tool_call) = extract_tool_call_from_block(block) {
            upsert_tool_call(tool_calls, &tool_call);
            ensure_tool_use(content_blocks, &tool_call.id);
            on_tool_use(&tool_call);
        }
    }
}

fn emit_chunk(app: &AppHandle, session_id: &str, worktree_id: &str, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    let _ = app.emit_all(
        "chat:chunk",
        &ChunkEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            content: chunk.to_string(),
        },
    );
}

fn emit_tool_use(app: &AppHandle, session_id: &str, worktree_id: &str, tool_call: &ParsedToolCall) {
    let _ = app.emit_all(
        "chat:tool_use",
        &ToolUseEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            id: tool_call.id.clone(),
            name: tool_call.name.clone(),
            input: tool_call.input.clone(),
            parent_tool_use_id: None,
        },
    );
    let _ = app.emit_all(
        "chat:tool_block",
        &ToolBlockEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            tool_call_id: tool_call.id.clone(),
        },
    );
}

fn emit_tool_result(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    tool_use_id: &str,
    output: &str,
) {
    let _ = app.emit_all(
        "chat:tool_result",
        &ToolResultEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            tool_use_id: tool_use_id.to_string(),
            output: output.to_string(),
        },
    );
}

fn emit_done(app: &AppHandle, session_id: &str, worktree_id: &str, waiting_for_plan: bool) {
    let _ = app.emit_all(
        "chat:done",
        &serde_json::json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
            "waiting_for_plan": waiting_for_plan,
        }),
    );
}

fn parse_grok_stream(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    reader: impl BufRead,
    initial_session_id: Option<&str>,
) -> Result<GrokResponse, String> {
    parse_grok_stream_inner_with_callbacks(
        reader,
        initial_session_id,
        |chunk| emit_chunk(app, session_id, worktree_id, chunk),
        |tool_call| emit_tool_use(app, session_id, worktree_id, tool_call),
        |tool_use_id, output| emit_tool_result(app, session_id, worktree_id, tool_use_id, output),
    )
}

#[cfg(test)]
fn parse_grok_stream_inner(
    reader: impl BufRead,
    initial_session_id: Option<&str>,
) -> Result<GrokResponse, String> {
    parse_grok_stream_inner_with_callbacks(reader, initial_session_id, |_| {}, |_| {}, |_, _| {})
}

fn parse_grok_stream_inner_with_callbacks<ChunkFn, ToolUseFn, ToolResultFn>(
    reader: impl BufRead,
    initial_session_id: Option<&str>,
    mut on_chunk: ChunkFn,
    mut on_tool_use: ToolUseFn,
    mut on_tool_result: ToolResultFn,
) -> Result<GrokResponse, String>
where
    ChunkFn: FnMut(&str),
    ToolUseFn: FnMut(&ParsedToolCall),
    ToolResultFn: FnMut(&str, &str),
{
    let mut content = String::new();
    let mut content_blocks = Vec::new();
    let mut tool_calls = Vec::new();
    let mut session_id = initial_session_id.unwrap_or_default().to_string();
    let mut usage = None;

    for line in reader.lines() {
        let raw_line = line.map_err(|e| format!("Failed to read Grok CLI output: {e}"))?;
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        log::debug!("[Grok] stream line: {line}");
        let parsed: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                log::debug!("[Grok] skipping non-JSON line: {line}");
                continue;
            }
        };

        if let Some(extracted_session_id) = extract_session_id(&parsed) {
            session_id = extracted_session_id;
        }
        if usage.is_none() {
            usage = extract_usage(&parsed);
        }

        if let Some(blocks) = extract_message_blocks(&parsed) {
            process_message_blocks(
                blocks,
                &mut content,
                &mut content_blocks,
                &mut tool_calls,
                &mut on_chunk,
                &mut on_tool_use,
            );
        } else if let Some(delta) = extract_text_delta(&parsed) {
            content.push_str(&delta);
            push_text_block(&mut content_blocks, &delta);
            on_chunk(&delta);
        }

        let event_type = parsed
            .get("type")
            .and_then(Value::as_str)
            .or_else(|| parsed.get("event").and_then(Value::as_str))
            .unwrap_or("unknown");
        match event_type {
            // Grok streaming-json text deltas: {"type":"text","data":"..."}.
            // extract_text_delta above does not read `data`, so capture it here.
            // `thought` events (reasoning) are intentionally ignored, not appended to content.
            "text" => {
                if let Some(text) = parsed
                    .get("data")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    content.push_str(text);
                    push_text_block(&mut content_blocks, text);
                    on_chunk(text);
                }
            }
            "tool_call" | "tool_use" | "tool" => {
                if let Some(tool_call) = extract_tool_call_event(&parsed) {
                    upsert_tool_call(&mut tool_calls, &tool_call);
                    ensure_tool_use(&mut content_blocks, &tool_call.id);
                    on_tool_use(&tool_call);
                }
            }
            "tool_result" | "tool_output" => {
                if let Some((tool_use_id, output)) = extract_tool_result_event(&parsed) {
                    set_tool_result(&mut tool_calls, &tool_use_id, &output);
                    on_tool_result(&tool_use_id, &output);
                }
            }
            "result" | "complete" | "completion" => {
                if let Some(text) = extract_final_result_text(&parsed) {
                    if content.is_empty() {
                        push_text_block(&mut content_blocks, &text);
                        on_chunk(&text);
                        content = text;
                    }
                }
            }
            _ => {}
        }
    }

    Ok(GrokResponse {
        content: content.trim().to_string(),
        session_id,
        tool_calls,
        content_blocks,
        cancelled: false,
        usage,
    })
}

fn inject_synthetic_plan(response: &mut GrokResponse) -> bool {
    if response.content.trim().is_empty()
        || response
            .tool_calls
            .iter()
            .any(|tool| tool.name == GROK_SYNTHETIC_PLAN_TOOL_NAME)
    {
        return false;
    }
    let id = "grok-plan".to_string();
    response.tool_calls.push(ToolCall {
        id: id.clone(),
        name: GROK_SYNTHETIC_PLAN_TOOL_NAME.to_string(),
        input: serde_json::json!({
            "source": "grok",
            "plan": response.content,
        }),
        output: None,
        parent_tool_use_id: None,
    });
    response
        .content_blocks
        .push(ContentBlock::ToolUse { tool_call_id: id });
    true
}

/// Render the resolved Grok CLI invocation as a copy-pasteable shell command for debug logs.
/// The prompt value (after `-p`/`--prompt`) is redacted so user prompt text / PII never
/// reaches persistent logs.
fn format_grok_command(cli_path: &Path, args: &[String]) -> String {
    fn quote(arg: &str) -> String {
        if arg.is_empty() || arg.contains([' ', '"', '\'', '\n', '\t']) {
            format!("'{}'", arg.replace('\'', "'\\''"))
        } else {
            arg.to_string()
        }
    }
    let mut parts = vec![quote(&cli_path.to_string_lossy())];
    let mut redact_next = false;
    for arg in args {
        if redact_next {
            parts.push("<REDACTED_PROMPT>".to_string());
            redact_next = false;
            continue;
        }
        if arg == "-p" || arg == "--prompt" {
            redact_next = true;
        }
        parts.push(quote(arg));
    }
    parts.join(" ")
}

fn build_grok_args(
    prompt: &str,
    model: Option<&str>,
    execution_mode: Option<&str>,
    effort_level: Option<&str>,
    grok_session_id: Option<&str>,
    working_dir: &str,
) -> Vec<String> {
    let effective_mode = execution_mode.unwrap_or("plan");
    let mut args = vec![
        "--no-auto-update".to_string(),
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "streaming-json".to_string(),
        "--cwd".to_string(),
        working_dir.to_string(),
    ];

    if let Some(id) = grok_session_id.filter(|id| !id.is_empty()) {
        args.push("--resume".to_string());
        args.push(id.to_string());
    }
    if let Some(model) = raw_grok_model(model).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = effort_level.filter(|effort| !effort.is_empty()) {
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }

    match effective_mode {
        "build" => {
            args.push("--permission-mode".to_string());
            args.push("acceptEdits".to_string());
            args.push("--sandbox".to_string());
            args.push("workspace".to_string());
        }
        "yolo" => {
            args.push("--permission-mode".to_string());
            args.push("bypassPermissions".to_string());
            args.push("--sandbox".to_string());
            args.push("off".to_string());
            args.push("--always-approve".to_string());
        }
        _ => {
            args.push("--permission-mode".to_string());
            args.push("plan".to_string());
            args.push("--sandbox".to_string());
            args.push("read-only".to_string());
        }
    }
    args
}

fn build_grok_message(message: &str, system_prompt: Option<&str>) -> String {
    match system_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        Some(prompt) => {
            format!("<system_instructions>\n{prompt}\n</system_instructions>\n\n{message}")
        }
        None => message.to_string(),
    }
}

pub struct GrokExecutionOptions<'a> {
    pub app: &'a AppHandle,
    pub jean_session_id: &'a str,
    pub worktree_id: &'a str,
    pub working_dir: &'a Path,
    pub existing_grok_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub execution_mode: Option<&'a str>,
    pub effort_level: Option<&'a str>,
    pub message: &'a str,
    pub system_prompt: Option<&'a str>,
    pub pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
}

pub fn execute_grok(options: GrokExecutionOptions<'_>) -> Result<GrokResponse, String> {
    let GrokExecutionOptions {
        app,
        jean_session_id,
        worktree_id,
        working_dir,
        existing_grok_session_id,
        model,
        execution_mode,
        effort_level,
        message,
        system_prompt,
        pid_callback,
    } = options;
    let cli_path = crate::grok_cli::resolve_cli_binary(app);
    if !crate::grok_cli::binary_exists(&cli_path) {
        return Err("Grok CLI not installed".to_string());
    }

    let existing_grok_session_id = existing_grok_session_id.filter(|id| !id.is_empty());
    let prepared_message = build_grok_message(message, system_prompt);
    let args = build_grok_args(
        &prepared_message,
        model,
        execution_mode,
        effort_level,
        existing_grok_session_id,
        &working_dir.to_string_lossy(),
    );

    log::info!(
        "[Grok] execute session={jean_session_id} worktree={worktree_id} \
         model={model:?} execution_mode={execution_mode:?} \
         existing_grok_session_id={existing_grok_session_id:?} cwd={}",
        working_dir.display()
    );
    log::info!("[Grok] cli_path={}", cli_path.display());
    log::info!("[Grok] command: {}", format_grok_command(&cli_path, &args));

    let mut cmd = silent_command(&cli_path);
    cmd.args(&args)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.env("JEAN_SESSION_ID", jean_session_id);
    cmd.env("JEAN_WORKTREE_ID", worktree_id);
    let (depth_key, depth_val) = super::jean_mcp::child_depth_env();
    cmd.env(depth_key, depth_val);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Grok CLI: {e}"))?;
    let pid = child.id();
    log::info!("[Grok] spawned pid={pid}");
    if let Some(cb) = pid_callback {
        cb(pid);
    }
    if !super::registry::register_process(jean_session_id.to_string(), pid) {
        return Ok(GrokResponse {
            content: String::new(),
            session_id: existing_grok_session_id.unwrap_or_default().to_string(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            usage: None,
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture Grok CLI stdout".to_string())?;
    let stderr_handle = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf);
            buf
        })
    });

    let mut response = parse_grok_stream(
        app,
        jean_session_id,
        worktree_id,
        BufReader::new(stdout),
        existing_grok_session_id,
    )?;
    log::info!("[Grok] stdout stream closed (EOF) for session={jean_session_id}, waiting for exit");
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Grok CLI: {e}"))?;
    let cancelled = !super::registry::is_process_running(jean_session_id);
    super::registry::unregister_process(jean_session_id);
    response.cancelled = cancelled;
    let stderr = stderr_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_else(|| String::from_utf8_lossy(&output.stderr).to_string());
    log::info!(
        "[Grok] exited session={jean_session_id} status={:?} success={} cancelled={} \
         content_len={} tool_calls={} stderr_len={}",
        output.status.code(),
        output.status.success(),
        cancelled,
        response.content.len(),
        response.tool_calls.len(),
        stderr.len()
    );
    if !stderr.trim().is_empty() {
        log::warn!("[Grok] stderr: {}", strip_ansi(&stderr).trim());
    }

    if !output.status.success() && !cancelled {
        let error = strip_ansi(&stderr);
        let message = if error.trim().is_empty() {
            "Grok CLI exited with a non-zero status".to_string()
        } else {
            error.trim().to_string()
        };
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: jean_session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: message.clone(),
            },
        );
        return Err(message);
    }

    let waiting_for_plan = execution_mode == Some("plan") && inject_synthetic_plan(&mut response);
    if !response.cancelled {
        emit_done(app, jean_session_id, worktree_id, waiting_for_plan);
    }

    Ok(response)
}

fn extract_json_object(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        let is_grok_wrapper = value.get("text").and_then(Value::as_str).is_some()
            && (value.get("stopReason").is_some()
                || value.get("sessionId").is_some()
                || value.get("requestId").is_some()
                || value.get("thought").is_some());
        if is_grok_wrapper {
            if let Some(inner) = value.get("text").and_then(Value::as_str) {
                return extract_json_object(inner);
            }
        }
        return Ok(trimmed.to_string());
    }
    let start = trimmed
        .find('{')
        .ok_or("No JSON object found in Grok response".to_string())?;
    let end = trimmed
        .rfind('}')
        .ok_or("No JSON object found in Grok response".to_string())?;
    let candidate = &trimmed[start..=end];
    serde_json::from_str::<Value>(candidate)
        .map_err(|e| format!("Invalid JSON object in Grok response: {e}"))?;
    Ok(candidate.to_string())
}

pub fn execute_one_shot_grok(
    app: &AppHandle,
    prompt: &str,
    model: &str,
    working_dir: Option<&Path>,
    effort_level: Option<&str>,
) -> Result<String, String> {
    let cli_path = crate::grok_cli::resolve_cli_binary(app);
    if !crate::grok_cli::binary_exists(&cli_path) {
        return Err("Grok CLI not installed".to_string());
    }
    let dir = working_dir.unwrap_or_else(|| Path::new("."));
    let model = resolve_one_shot_grok_model(model);
    let json_prompt =
        format!("{prompt}\n\nReturn only a single valid JSON object. Do not wrap it in markdown.");
    let mut cmd = silent_command(&cli_path);
    cmd.args([
        "--no-auto-update",
        "-p",
        &json_prompt,
        "--output-format",
        "json",
        "--cwd",
        &dir.to_string_lossy(),
        "--permission-mode",
        "dontAsk",
        "--sandbox",
        "read-only",
        "--model",
        raw_grok_model(Some(model)).unwrap_or(model),
    ]);
    if let Some(effort) = effort_level.filter(|effort| !effort.is_empty()) {
        cmd.args(["--effort", effort]);
    }
    cmd.current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run Grok one-shot request: {e}"))?;
    if !output.status.success() {
        let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
        return Err(format!("Grok one-shot request failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_json_object(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[test]
    fn resolve_one_shot_grok_model_coerces_non_grok_to_default() {
        // Claude/other-backend defaults must collapse to the Grok default.
        assert_eq!(
            resolve_one_shot_grok_model("claude-opus-4-8[1m]"),
            GROK_DEFAULT_MODEL
        );
        assert_eq!(resolve_one_shot_grok_model("sonnet"), GROK_DEFAULT_MODEL);
        // Grok models pass through unchanged.
        assert_eq!(resolve_one_shot_grok_model("grok-build"), "grok-build");
        assert_eq!(
            resolve_one_shot_grok_model("grok/grok-composer-2.5-fast"),
            "grok/grok-composer-2.5-fast"
        );
    }

    #[test]
    fn parse_grok_streaming_json_text_chunks_and_session_id() {
        let input = r#"
{"type":"session","session_id":"grok-session-1"}
{"type":"assistant","delta":"Hello "}
{"type":"assistant","delta":"from Grok"}
{"type":"result","usage":{"input_tokens":3,"output_tokens":4}}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        assert_eq!(response.content, "Hello from Grok");
        assert_eq!(response.session_id, "grok-session-1");
        assert_eq!(response.usage.unwrap().output_tokens, 4);
    }

    #[test]
    fn parse_grok_streaming_json_text_data_and_end_event() {
        // Grok's documented streaming-json schema: text via `data`, terminal `end` event.
        let input = r#"
{"type":"text","data":"Hello "}
{"type":"thought","data":"thinking out loud"}
{"type":"text","data":"world"}
{"type":"end","stopReason":"EndTurn","sessionId":"grok-session-9"}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        // `thought` data must NOT leak into content.
        assert_eq!(response.content, "Hello world");
        assert_eq!(response.session_id, "grok-session-9");
    }

    #[test]
    fn build_grok_args_omits_undocumented_alt_screen_flag() {
        let args = build_grok_args(
            "hello",
            Some("grok-composer-2.5-fast"),
            Some("plan"),
            None,
            Some("session-1"),
            "/tmp/worktree",
        );
        assert!(!args.contains(&"--no-alt-screen".to_string()));
    }

    #[test]
    fn build_grok_args_uses_resume_flag_for_existing_session() {
        let args = build_grok_args(
            "hello",
            Some("grok-composer-2.5-fast"),
            Some("plan"),
            None,
            Some("grok-session-1"),
            "/tmp/worktree",
        );

        assert!(!args.contains(&"--session-id".to_string()));
        let idx = args
            .iter()
            .position(|arg| arg == "--resume")
            .expect("--resume flag present");
        assert_eq!(args.get(idx + 1), Some(&"grok-session-1".to_string()));
    }

    #[test]
    fn extract_json_object_reads_grok_json_output_text_wrapper() {
        let stdout = r#"{
  "text": "{\"summary\":\"Done\",\"slug\":\"done\"}",
  "stopReason": "EndTurn",
  "sessionId": "grok-session-1"
}"#;

        assert_eq!(
            extract_json_object(stdout).unwrap(),
            r#"{"summary":"Done","slug":"done"}"#
        );
    }

    #[test]
    fn build_grok_args_map_execution_modes() {
        let plan = build_grok_args(
            "hello",
            Some("grok-composer-2.5-fast"),
            Some("plan"),
            None,
            Some("session-1"),
            "/tmp/worktree",
        );
        assert!(plan.contains(&"--permission-mode".to_string()));
        assert!(plan.contains(&"plan".to_string()));
        assert!(plan.contains(&"--sandbox".to_string()));
        assert!(plan.contains(&"read-only".to_string()));

        let yolo = build_grok_args(
            "hello",
            Some("grok-composer-2.5-fast"),
            Some("yolo"),
            None,
            Some("session-1"),
            "/tmp/worktree",
        );
        assert!(yolo.contains(&"bypassPermissions".to_string()));
        assert!(yolo.contains(&"off".to_string()));
    }

    #[test]
    fn build_grok_args_includes_effort_flag() {
        let args = build_grok_args(
            "hello",
            Some("grok-composer-2.5-fast"),
            Some("plan"),
            Some("high"),
            Some("session-1"),
            "/tmp/worktree",
        );
        let idx = args
            .iter()
            .position(|a| a == "--effort")
            .expect("--effort flag present");
        assert_eq!(args.get(idx + 1), Some(&"high".to_string()));
    }

    #[test]
    fn build_grok_args_omits_effort_flag_when_none() {
        let args = build_grok_args(
            "hello",
            Some("grok-composer-2.5-fast"),
            Some("plan"),
            None,
            Some("session-1"),
            "/tmp/worktree",
        );
        assert!(!args.contains(&"--effort".to_string()));
    }
}
