//! Grok Build CLI execution engine.

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
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
    let output = value_to_output_text(&output_value)?;
    Some((tool_use_id, output))
}

fn extract_tool_result_from_block(block: &Value) -> Option<(String, String)> {
    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
        return None;
    }
    let tool_use_id = first_string(
        block,
        &[
            &["tool_use_id"],
            &["toolUseId"],
            &["tool_call_id"],
            &["toolCallId"],
            &["id"],
        ],
    )?;
    let output_value = first_value(block, &[&["content"], &["output"], &["result"], &["text"]])?;
    let output = value_to_output_text(&output_value)?;
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

fn process_message_blocks<ChunkFn, ToolUseFn, ToolResultFn>(
    blocks: &[Value],
    content: &mut String,
    content_blocks: &mut Vec<ContentBlock>,
    tool_calls: &mut Vec<ToolCall>,
    on_chunk: &mut ChunkFn,
    on_tool_use: &mut ToolUseFn,
    on_tool_result: &mut ToolResultFn,
) where
    ChunkFn: FnMut(&str),
    ToolUseFn: FnMut(&ParsedToolCall),
    ToolResultFn: FnMut(&str, &str),
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
            continue;
        }
        if let Some((tool_use_id, output)) = extract_tool_result_from_block(block) {
            set_tool_result(tool_calls, &tool_use_id, &output);
            on_tool_result(&tool_use_id, &output);
        }
    }
}

fn extract_acp_update(value: &Value) -> Option<&Value> {
    value_at_path(value, &["params", "update"])
}

fn extract_acp_session_id(value: &Value) -> Option<String> {
    first_string(
        value,
        &[&["params", "sessionId"], &["result", "_meta", "sessionId"]],
    )
}

fn extract_text_from_acp_content(content: &Value) -> Option<String> {
    if content.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    content
        .get("text")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn extract_acp_tool_call(update: &Value) -> Option<ParsedToolCall> {
    let id = first_string(update, &[&["toolCallId"], &["tool_call_id"]])?;
    if update.get("title").is_none()
        && update.get("kind").is_none()
        && update.get("rawInput").is_none()
    {
        return None;
    }
    let name = first_string(update, &[&["title"], &["kind"], &["name"]])
        .unwrap_or_else(|| "Tool".to_string());
    let input = update.get("rawInput").cloned().unwrap_or(Value::Null);
    Some(ParsedToolCall { id, name, input })
}

fn acp_tool_output(update: &Value) -> Option<String> {
    let raw_output = update.get("rawOutput")?;
    if let Some(text) = first_string(
        raw_output,
        &[
            &["output_for_prompt"],
            &["outputForPrompt"],
            &["raw_output"],
            &["rawOutput"],
            &["content"],
            &["text"],
        ],
    ) {
        return Some(text).filter(|text| !text.is_empty());
    }
    if let Some(output) = raw_output.get("output") {
        return value_to_output_text(output);
    }
    value_to_output_text(raw_output)
}

fn value_to_output_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let bytes: Option<Vec<u8>> = items
                .iter()
                .map(|item| item.as_u64().and_then(|number| u8::try_from(number).ok()))
                .collect();
            if let Some(bytes) = bytes {
                String::from_utf8_lossy(&bytes).to_string()
            } else {
                let content_text = items
                    .iter()
                    .filter_map(|item| {
                        item.as_str()
                            .map(ToOwned::to_owned)
                            .or_else(|| extract_text_from_block(item))
                    })
                    .collect::<String>();
                if content_text.is_empty() {
                    value.to_string()
                } else {
                    content_text
                }
            }
        }
        Value::Null => return None,
        other => other.to_string(),
    };
    Some(text).filter(|text| !text.is_empty())
}

fn usage_from_acp_meta(meta: &Value) -> Option<UsageData> {
    let input_tokens = meta
        .get("inputTokens")
        .or_else(|| meta.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = meta
        .get("outputTokens")
        .or_else(|| meta.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read_input_tokens = meta
        .get("cachedReadTokens")
        .or_else(|| meta.get("cache_read_input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if input_tokens == 0 && output_tokens == 0 && cache_read_input_tokens == 0 {
        return None;
    }
    Some(UsageData {
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens: 0,
    })
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
        if let Some(extracted_session_id) = extract_acp_session_id(&parsed) {
            session_id = extracted_session_id;
        }
        if usage.is_none() {
            usage = extract_usage(&parsed).or_else(|| {
                value_at_path(&parsed, &["result", "_meta"]).and_then(usage_from_acp_meta)
            });
        }

        if let Some(update) = extract_acp_update(&parsed) {
            match update.get("sessionUpdate").and_then(Value::as_str) {
                Some("agent_message_chunk") => {
                    if let Some(text) = update
                        .get("content")
                        .and_then(extract_text_from_acp_content)
                        .filter(|text| !text.is_empty())
                    {
                        content.push_str(&text);
                        push_text_block(&mut content_blocks, &text);
                        on_chunk(&text);
                    }
                }
                Some("tool_call") => {
                    if let Some(tool_call) = extract_acp_tool_call(update) {
                        upsert_tool_call(&mut tool_calls, &tool_call);
                        ensure_tool_use(&mut content_blocks, &tool_call.id);
                        on_tool_use(&tool_call);
                    }
                }
                Some("tool_call_update") => {
                    if let Some(tool_call) = extract_acp_tool_call(update) {
                        upsert_tool_call(&mut tool_calls, &tool_call);
                        ensure_tool_use(&mut content_blocks, &tool_call.id);
                        on_tool_use(&tool_call);
                    }
                    if let (Some(tool_use_id), Some(output)) = (
                        first_string(update, &[&["toolCallId"], &["tool_call_id"]]),
                        acp_tool_output(update),
                    ) {
                        set_tool_result(&mut tool_calls, &tool_use_id, &output);
                        on_tool_result(&tool_use_id, &output);
                    }
                }
                _ => {}
            }
        } else if let Some(blocks) = extract_message_blocks(&parsed) {
            process_message_blocks(
                blocks,
                &mut content,
                &mut content_blocks,
                &mut tool_calls,
                &mut on_chunk,
                &mut on_tool_use,
                &mut on_tool_result,
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

fn build_grok_agent_args(
    model: Option<&str>,
    execution_mode: Option<&str>,
    effort_level: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--no-auto-update".to_string(),
        "agent".to_string(),
        "--no-leader".to_string(),
    ];
    if matches!(execution_mode, Some("build") | Some("yolo")) {
        args.push("--always-approve".to_string());
    }
    if let Some(model) = raw_grok_model(model).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = effort_level.filter(|effort| !effort.is_empty()) {
        args.push("--reasoning-effort".to_string());
        args.push(effort.to_string());
    }
    args.push("stdio".to_string());
    args
}

struct AcpTerminal {
    child: Arc<Mutex<Child>>,
    output: Arc<Mutex<String>>,
    truncated: Arc<AtomicBool>,
    output_limit: usize,
}

struct GrokAcpConnection {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    stderr: Arc<Mutex<String>>,
    terminals: HashMap<String, AcpTerminal>,
    acp_session_id: String,
    args: Vec<String>,
    next_request_id: i64,
    pid: u32,
    in_use: bool,
    last_used: Instant,
}

static GROK_ACP_CONNECTIONS: Lazy<Mutex<HashMap<String, Arc<Mutex<GrokAcpConnection>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const GROK_ACP_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn should_keep_grok_acp_connection_alive(
    last_used: Instant,
    in_use: bool,
    now: Instant,
    timeout: Duration,
) -> bool {
    in_use || now.duration_since(last_used) < timeout
}

fn append_terminal_output(
    output: &Arc<Mutex<String>>,
    truncated: &Arc<AtomicBool>,
    output_limit: usize,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    let Ok(mut output) = output.lock() else {
        return;
    };
    output.push_str(text);
    while output.len() > output_limit {
        output.remove(0);
        truncated.store(true, Ordering::Relaxed);
    }
}

fn spawn_terminal_reader(
    mut reader: impl Read + Send + 'static,
    output: Arc<Mutex<String>>,
    truncated: Arc<AtomicBool>,
    output_limit: usize,
) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buffer[..n]);
                    append_terminal_output(&output, &truncated, output_limit, &text);
                }
            }
        }
    });
}

fn exit_status_json(status: ExitStatus) -> Value {
    serde_json::json!({
        "exitCode": status.code(),
        "signal": null,
    })
}

fn send_acp_message(stdin: &mut impl std::io::Write, value: &Value) -> Result<(), String> {
    writeln!(stdin, "{value}").map_err(|e| format!("Failed to write Grok ACP message: {e}"))
}

fn send_acp_request(
    stdin: &mut impl std::io::Write,
    id: i64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    send_acp_message(
        stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }),
    )
}

fn send_acp_response(
    stdin: &mut impl std::io::Write,
    id: &Value,
    result: Value,
) -> Result<(), String> {
    send_acp_message(
        stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }),
    )
}

fn send_acp_error(
    stdin: &mut impl std::io::Write,
    id: &Value,
    message: &str,
) -> Result<(), String> {
    send_acp_message(
        stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32000,
                "message": message,
            },
        }),
    )
}

fn acp_auth_method(init: &Value) -> Option<String> {
    let methods = init
        .get("authMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ids = methods
        .iter()
        .filter_map(|method| method.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if std::env::var("XAI_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        && ids.contains(&"xai.api_key")
    {
        return Some("xai.api_key".to_string());
    }
    if ids.contains(&"cached_token") {
        return Some("cached_token".to_string());
    }
    None
}

fn selected_permission_option(params: &Value, allow: bool) -> Option<String> {
    let preferred = if allow {
        ["allow_once", "allow_always"]
    } else {
        ["reject_once", "reject_always"]
    };
    let options = params.get("options").and_then(Value::as_array)?;
    preferred.iter().find_map(|kind| {
        options
            .iter()
            .find(|option| option.get("kind").and_then(Value::as_str) == Some(*kind))
            .and_then(|option| option.get("optionId").and_then(Value::as_str))
            .map(ToOwned::to_owned)
    })
}

fn handle_acp_client_request(
    stdin: &mut impl std::io::Write,
    request: &Value,
    terminals: &mut HashMap<String, AcpTerminal>,
    execution_mode: Option<&str>,
) -> Result<(), String> {
    let Some(id) = request.get("id") else {
        return Ok(());
    };
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "session/request_permission" => {
            let allow = !matches!(execution_mode, Some("plan") | None);
            let Some(option_id) = selected_permission_option(&params, allow) else {
                return send_acp_error(stdin, id, "No matching permission option");
            };
            send_acp_response(
                stdin,
                id,
                serde_json::json!({
                    "outcome": {
                        "outcome": "selected",
                        "optionId": option_id,
                    }
                }),
            )
        }
        "terminal/create" => {
            if matches!(execution_mode, Some("plan") | None) {
                return send_acp_error(stdin, id, "Terminal execution is disabled in plan mode");
            }
            let Some(command) = params.get("command").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminal command");
            };
            let terminal_id = format!("grok-terminal-{}", terminals.len() + 1);
            let cwd = params.get("cwd").and_then(Value::as_str);
            let output_limit = params
                .get("outputByteLimit")
                .and_then(Value::as_u64)
                .unwrap_or(20_000)
                .clamp(1024, 200_000) as usize;

            #[cfg(windows)]
            let mut command_builder = {
                let mut cmd = crate::platform::silent_command("cmd");
                cmd.args(["/C", command]);
                cmd
            };
            #[cfg(not(windows))]
            let mut command_builder = {
                let mut cmd = crate::platform::silent_command("sh");
                cmd.args(["-lc", command]);
                cmd
            };
            if let Some(cwd) = cwd {
                command_builder.current_dir(cwd);
            }
            if let Some(env) = params.get("env").and_then(Value::as_array) {
                for entry in env {
                    if let (Some(name), Some(value)) = (
                        entry.get("name").and_then(Value::as_str),
                        entry.get("value").and_then(Value::as_str),
                    ) {
                        command_builder.env(name, value);
                    }
                }
            }
            let mut child = command_builder
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn Grok ACP terminal command: {e}"))?;
            let output = Arc::new(Mutex::new(String::new()));
            let truncated = Arc::new(AtomicBool::new(false));
            if let Some(stdout) = child.stdout.take() {
                spawn_terminal_reader(stdout, output.clone(), truncated.clone(), output_limit);
            }
            if let Some(stderr) = child.stderr.take() {
                spawn_terminal_reader(stderr, output.clone(), truncated.clone(), output_limit);
            }
            terminals.insert(
                terminal_id.clone(),
                AcpTerminal {
                    child: Arc::new(Mutex::new(child)),
                    output,
                    truncated,
                    output_limit,
                },
            );
            send_acp_response(stdin, id, serde_json::json!({ "terminalId": terminal_id }))
        }
        "terminal/output" => {
            let Some(terminal_id) = params.get("terminalId").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminalId");
            };
            let Some(terminal) = terminals.get(terminal_id) else {
                return send_acp_error(stdin, id, "Unknown terminalId");
            };
            let exit_status = terminal
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok().flatten())
                .map(exit_status_json);
            let output = terminal
                .output
                .lock()
                .map(|output| output.clone())
                .unwrap_or_default();
            send_acp_response(
                stdin,
                id,
                serde_json::json!({
                    "output": output,
                    "truncated": terminal.truncated.load(Ordering::Relaxed),
                    "exitStatus": exit_status,
                }),
            )
        }
        "terminal/wait_for_exit" => {
            let Some(terminal_id) = params.get("terminalId").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminalId");
            };
            let Some(terminal) = terminals.get(terminal_id) else {
                return send_acp_error(stdin, id, "Unknown terminalId");
            };
            let status = terminal
                .child
                .lock()
                .map_err(|_| "Failed to lock terminal process".to_string())?
                .wait()
                .map_err(|e| format!("Failed to wait for terminal: {e}"))?;
            send_acp_response(stdin, id, exit_status_json(status))
        }
        "terminal/kill" => {
            let Some(terminal_id) = params.get("terminalId").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminalId");
            };
            if let Some(terminal) = terminals.get(terminal_id) {
                if let Ok(mut child) = terminal.child.lock() {
                    let _ = child.kill();
                }
            }
            send_acp_response(stdin, id, serde_json::json!({}))
        }
        "terminal/release" => {
            let Some(terminal_id) = params.get("terminalId").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminalId");
            };
            if let Some(terminal) = terminals.remove(terminal_id) {
                if let Ok(mut child) = terminal.child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            send_acp_response(stdin, id, serde_json::json!({}))
        }
        "fs/read_text_file" | "fs/readTextFile" => {
            let Some(path) = params.get("path").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing path");
            };
            let content = std::fs::read_to_string(path)
                .map_err(|e| format!("Failed to read Grok ACP file {path}: {e}"))?;
            let line = params.get("line").and_then(Value::as_u64).unwrap_or(1);
            let limit = params.get("limit").and_then(Value::as_u64);
            let selected = if line > 1 || limit.is_some() {
                let start = line.saturating_sub(1) as usize;
                let iter = content.lines().skip(start);
                match limit {
                    Some(limit) => iter.take(limit as usize).collect::<Vec<_>>().join("\n"),
                    None => iter.collect::<Vec<_>>().join("\n"),
                }
            } else {
                content
            };
            send_acp_response(stdin, id, serde_json::json!({ "content": selected }))
        }
        "fs/write_text_file" | "fs/writeTextFile" => {
            if matches!(execution_mode, Some("plan") | None) {
                return send_acp_error(stdin, id, "File writes are disabled in plan mode");
            }
            let Some(path) = params.get("path").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing path");
            };
            let Some(content) = params.get("content").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing content");
            };
            std::fs::write(path, content)
                .map_err(|e| format!("Failed to write Grok ACP file {path}: {e}"))?;
            send_acp_response(stdin, id, serde_json::json!({}))
        }
        _ => send_acp_error(
            stdin,
            id,
            &format!("Unsupported Grok ACP request: {method}"),
        ),
    }
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

fn read_acp_response(
    connection: &mut GrokAcpConnection,
    request_id: i64,
    execution_mode: Option<&str>,
    context: &str,
) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        if connection
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read Grok ACP {context} response: {e}"))?
            == 0
        {
            return Err(format!("Grok ACP exited before {context} completed"));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("method").is_some()
            && value.get("id").is_some()
            && value.get("id").and_then(Value::as_i64) != Some(request_id)
        {
            handle_acp_client_request(
                &mut connection.stdin,
                &value,
                &mut connection.terminals,
                execution_mode,
            )?;
            continue;
        }
        if value.get("id").and_then(Value::as_i64) == Some(request_id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Grok ACP {context} failed: {error}"));
            }
            return Ok(value);
        }
    }
}

fn spawn_grok_acp_connection(
    cli_path: &Path,
    args: Vec<String>,
    jean_session_id: &str,
    worktree_id: &str,
    working_dir: &Path,
    existing_grok_session_id: Option<&str>,
    execution_mode: Option<&str>,
) -> Result<GrokAcpConnection, String> {
    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), Some(working_dir));
    cmd.args(&args)
        .stdin(Stdio::piped())
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
    log::info!("[Grok ACP] spawned pid={pid}");
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture Grok CLI stdout".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or("Failed to open Grok CLI stdin".to_string())?;
    let stderr = Arc::new(Mutex::new(String::new()));
    if let Some(mut child_stderr) = child.stderr.take() {
        let stderr = stderr.clone();
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = child_stderr.read_to_string(&mut buf);
            if let Ok(mut stderr) = stderr.lock() {
                stderr.push_str(&buf);
            }
        });
    }

    let mut connection = GrokAcpConnection {
        child,
        stdin,
        reader: BufReader::new(stdout),
        stderr,
        terminals: HashMap::new(),
        acp_session_id: existing_grok_session_id.unwrap_or_default().to_string(),
        args,
        next_request_id: 1,
        pid,
        in_use: true,
        last_used: Instant::now(),
    };

    let initialize_id = connection.next_request_id;
    connection.next_request_id += 1;
    send_acp_request(
        &mut connection.stdin,
        initialize_id,
        "initialize",
        serde_json::json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": {
                    "readTextFile": true,
                    "writeTextFile": !matches!(execution_mode, Some("plan") | None),
                },
                "terminal": true,
            },
        }),
    )?;
    let init_value =
        read_acp_response(&mut connection, initialize_id, execution_mode, "initialize")?;
    let init = init_value
        .get("result")
        .cloned()
        .ok_or("Grok ACP did not return initialize result".to_string())?;
    let method_id =
        acp_auth_method(&init).ok_or("Run `grok login` first, or set XAI_API_KEY.".to_string())?;

    let auth_id = connection.next_request_id;
    connection.next_request_id += 1;
    send_acp_request(
        &mut connection.stdin,
        auth_id,
        "authenticate",
        serde_json::json!({ "methodId": method_id, "_meta": { "headless": true } }),
    )?;
    let _ = read_acp_response(&mut connection, auth_id, execution_mode, "authenticate")?;

    let (session_method, session_params) = match existing_grok_session_id {
        Some(session_id) => (
            "session/load",
            serde_json::json!({
                "sessionId": session_id,
                "cwd": working_dir.to_string_lossy(),
                "mcpServers": [],
            }),
        ),
        None => (
            "session/new",
            serde_json::json!({
                "cwd": working_dir.to_string_lossy(),
                "mcpServers": [],
            }),
        ),
    };
    let session_id = connection.next_request_id;
    connection.next_request_id += 1;
    send_acp_request(
        &mut connection.stdin,
        session_id,
        session_method,
        session_params,
    )?;
    let session_value = read_acp_response(&mut connection, session_id, execution_mode, "session")?;
    if let Some(acp_session_id) = extract_session_id(&session_value) {
        connection.acp_session_id = acp_session_id;
    }
    if connection.acp_session_id.is_empty() {
        return Err("Grok ACP did not return a session id".to_string());
    }

    Ok(connection)
}

fn kill_grok_acp_connection(connection: &mut GrokAcpConnection) {
    for (_, terminal) in connection.terminals.drain() {
        if let Ok(mut child) = terminal.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let _ = connection.child.kill();
    let _ = connection.child.wait();
}

fn schedule_grok_acp_idle_cleanup(key: String, connection: Arc<Mutex<GrokAcpConnection>>) {
    std::thread::spawn(move || {
        std::thread::sleep(GROK_ACP_IDLE_TIMEOUT);
        let should_remove = connection
            .lock()
            .map(|conn| {
                !should_keep_grok_acp_connection_alive(
                    conn.last_used,
                    conn.in_use,
                    Instant::now(),
                    GROK_ACP_IDLE_TIMEOUT,
                )
            })
            .unwrap_or(true);
        if !should_remove {
            return;
        }
        let Ok(mut registry) = GROK_ACP_CONNECTIONS.lock() else {
            return;
        };
        let Some(current) = registry.get(&key) else {
            return;
        };
        if !Arc::ptr_eq(current, &connection) {
            return;
        }
        if let Some(connection) = registry.remove(&key) {
            if let Ok(mut connection) = connection.lock() {
                log::info!(
                    "[Grok ACP] idle timeout reached; shutting down pid={}",
                    connection.pid
                );
                kill_grok_acp_connection(&mut connection);
            }
        }
    });
}

fn get_or_spawn_grok_acp_connection(
    cli_path: &Path,
    args: Vec<String>,
    jean_session_id: &str,
    worktree_id: &str,
    working_dir: &Path,
    existing_grok_session_id: Option<&str>,
    execution_mode: Option<&str>,
) -> Result<Arc<Mutex<GrokAcpConnection>>, String> {
    let key = jean_session_id.to_string();
    let mut registry = GROK_ACP_CONNECTIONS
        .lock()
        .map_err(|_| "Failed to lock Grok ACP registry".to_string())?;
    if let Some(existing) = registry.get(&key).cloned() {
        let mut keep_existing = false;
        if let Ok(mut connection) = existing.lock() {
            let alive = connection.child.try_wait().ok().flatten().is_none();
            keep_existing = alive && connection.args == args;
            if !keep_existing {
                kill_grok_acp_connection(&mut connection);
            }
        }
        if keep_existing {
            return Ok(existing);
        }
        registry.remove(&key);
    }

    let connection = spawn_grok_acp_connection(
        cli_path,
        args,
        jean_session_id,
        worktree_id,
        working_dir,
        existing_grok_session_id,
        execution_mode,
    )?;
    let connection = Arc::new(Mutex::new(connection));
    registry.insert(key, connection.clone());
    Ok(connection)
}

fn send_grok_acp_prompt(
    app: &AppHandle,
    connection: &mut GrokAcpConnection,
    jean_session_id: &str,
    worktree_id: &str,
    execution_mode: Option<&str>,
    prepared_message: &str,
) -> Result<GrokResponse, String> {
    let prompt_request_id = connection.next_request_id;
    connection.next_request_id += 1;
    send_acp_request(
        &mut connection.stdin,
        prompt_request_id,
        "session/prompt",
        serde_json::json!({
            "sessionId": connection.acp_session_id,
            "prompt": [{ "type": "text", "text": prepared_message }],
        }),
    )?;

    let mut response = GrokResponse {
        content: String::new(),
        session_id: connection.acp_session_id.clone(),
        tool_calls: Vec::new(),
        content_blocks: Vec::new(),
        cancelled: false,
        usage: None,
    };
    let mut line = String::new();
    loop {
        line.clear();
        if connection
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read Grok ACP prompt stream: {e}"))?
            == 0
        {
            return Err("Grok ACP exited before prompt completed".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        log::debug!("[Grok ACP] {trimmed}");
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("method").is_some() && value.get("id").is_some() {
            handle_acp_client_request(
                &mut connection.stdin,
                &value,
                &mut connection.terminals,
                execution_mode,
            )?;
            continue;
        }
        if let Some(session_id) = extract_acp_session_id(&value) {
            response.session_id = session_id;
        }
        if let Some(update) = extract_acp_update(&value) {
            match update.get("sessionUpdate").and_then(Value::as_str) {
                Some("agent_message_chunk") => {
                    if let Some(text) = update
                        .get("content")
                        .and_then(extract_text_from_acp_content)
                        .filter(|text| !text.is_empty())
                    {
                        response.content.push_str(&text);
                        push_text_block(&mut response.content_blocks, &text);
                        emit_chunk(app, jean_session_id, worktree_id, &text);
                    }
                }
                Some("tool_call") => {
                    if let Some(tool_call) = extract_acp_tool_call(update) {
                        upsert_tool_call(&mut response.tool_calls, &tool_call);
                        ensure_tool_use(&mut response.content_blocks, &tool_call.id);
                        emit_tool_use(app, jean_session_id, worktree_id, &tool_call);
                    }
                }
                Some("tool_call_update") => {
                    if let Some(tool_call) = extract_acp_tool_call(update) {
                        upsert_tool_call(&mut response.tool_calls, &tool_call);
                        ensure_tool_use(&mut response.content_blocks, &tool_call.id);
                        emit_tool_use(app, jean_session_id, worktree_id, &tool_call);
                    }
                    if let (Some(tool_use_id), Some(output)) = (
                        first_string(update, &[&["toolCallId"], &["tool_call_id"]]),
                        acp_tool_output(update),
                    ) {
                        set_tool_result(&mut response.tool_calls, &tool_use_id, &output);
                        emit_tool_result(app, jean_session_id, worktree_id, &tool_use_id, &output);
                    }
                }
                _ => {}
            }
        } else if let Some(blocks) = extract_message_blocks(&value) {
            process_message_blocks(
                blocks,
                &mut response.content,
                &mut response.content_blocks,
                &mut response.tool_calls,
                &mut |text| emit_chunk(app, jean_session_id, worktree_id, text),
                &mut |tool_call| emit_tool_use(app, jean_session_id, worktree_id, tool_call),
                &mut |tool_use_id, output| {
                    emit_tool_result(app, jean_session_id, worktree_id, tool_use_id, output)
                },
            );
        }
        if value.get("id").and_then(Value::as_i64) == Some(prompt_request_id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Grok ACP prompt failed: {error}"));
            }
            if response.usage.is_none() {
                response.usage =
                    value_at_path(&value, &["result", "_meta"]).and_then(usage_from_acp_meta);
            }
            break;
        }
    }
    response.content = response.content.trim().to_string();
    connection.acp_session_id = response.session_id.clone();
    Ok(response)
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
    let args = build_grok_agent_args(model, execution_mode, effort_level);

    log::info!(
        "[Grok] execute session={jean_session_id} worktree={worktree_id} \
         model={model:?} execution_mode={execution_mode:?} \
         existing_grok_session_id={existing_grok_session_id:?} cwd={}",
        working_dir.display()
    );
    log::info!("[Grok] cli_path={}", cli_path.display());
    log::info!("[Grok] command: {}", format_grok_command(&cli_path, &args));

    let connection = get_or_spawn_grok_acp_connection(
        &cli_path,
        args,
        jean_session_id,
        worktree_id,
        working_dir,
        existing_grok_session_id,
        execution_mode,
    )?;

    let key = jean_session_id.to_string();
    let mut connection_guard = connection
        .lock()
        .map_err(|_| "Failed to lock Grok ACP connection".to_string())?;
    connection_guard.in_use = true;
    let pid = connection_guard.pid;
    if let Some(cb) = pid_callback {
        cb(pid);
    }
    if !super::registry::register_process(jean_session_id.to_string(), pid) {
        connection_guard.in_use = false;
        connection_guard.last_used = Instant::now();
        return Ok(GrokResponse {
            content: String::new(),
            session_id: connection_guard.acp_session_id.clone(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            usage: None,
        });
    }

    let mut response = match send_grok_acp_prompt(
        app,
        &mut connection_guard,
        jean_session_id,
        worktree_id,
        execution_mode,
        &prepared_message,
    ) {
        Ok(response) => response,
        Err(error) => {
            let cancelled = !super::registry::is_process_running(jean_session_id);
            super::registry::unregister_process(jean_session_id);
            connection_guard.in_use = false;
            if cancelled || connection_guard.child.try_wait().ok().flatten().is_some() {
                kill_grok_acp_connection(&mut connection_guard);
                drop(connection_guard);
                if let Ok(mut registry) = GROK_ACP_CONNECTIONS.lock() {
                    registry.remove(&key);
                }
            }
            if cancelled {
                return Ok(GrokResponse {
                    content: String::new(),
                    session_id: existing_grok_session_id.unwrap_or_default().to_string(),
                    tool_calls: vec![],
                    content_blocks: vec![],
                    cancelled: true,
                    usage: None,
                });
            }
            let _ = app.emit_all(
                "chat:error",
                &ErrorEvent {
                    session_id: jean_session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    error: error.clone(),
                },
            );
            return Err(error);
        }
    };

    let cancelled = !super::registry::is_process_running(jean_session_id);
    super::registry::unregister_process(jean_session_id);
    response.cancelled = cancelled;
    let exited = connection_guard.child.try_wait().ok().flatten().is_some();
    let stderr = connection_guard
        .stderr
        .lock()
        .map(|stderr| stderr.clone())
        .unwrap_or_default();
    log::info!(
        "[Grok ACP] turn finished session={jean_session_id} pid={} cancelled={} exited={} \
         content_len={} tool_calls={} stderr_len={}",
        connection_guard.pid,
        cancelled,
        exited,
        response.content.len(),
        response.tool_calls.len(),
        stderr.len()
    );
    if !stderr.trim().is_empty() {
        log::warn!("[Grok ACP] stderr: {}", strip_ansi(&stderr).trim());
    }

    let waiting_for_plan = execution_mode == Some("plan") && inject_synthetic_plan(&mut response);
    if !response.cancelled {
        emit_done(app, jean_session_id, worktree_id, waiting_for_plan);
    }

    connection_guard.in_use = false;
    connection_guard.last_used = Instant::now();
    if cancelled || exited {
        kill_grok_acp_connection(&mut connection_guard);
        drop(connection_guard);
        if let Ok(mut registry) = GROK_ACP_CONNECTIONS.lock() {
            registry.remove(&key);
        }
    } else {
        drop(connection_guard);
        schedule_grok_acp_idle_cleanup(key, connection.clone());
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
    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), None);
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

    #[test]
    fn parse_grok_stream_reads_acp_agent_message_chunks() {
        let input = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"grok-acp-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"grok-acp-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" world"}}}}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        assert_eq!(response.content, "Hello world");
        assert_eq!(response.session_id, "grok-acp-1");
        assert_eq!(response.content_blocks.len(), 1);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::Text { text } if text == "Hello world"
        ));
    }

    #[test]
    fn parse_grok_stream_reads_acp_tool_call_updates() {
        let input = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"grok-acp-2","update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Shell","rawInput":{"command":"ls -la"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"grok-acp-2","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","rawOutput":"file list"}}}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        assert_eq!(response.session_id, "grok-acp-2");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "tool-1");
        assert_eq!(response.tool_calls[0].name, "Shell");
        assert_eq!(response.tool_calls[0].input["command"], "ls -la");
        assert_eq!(response.tool_calls[0].output.as_deref(), Some("file list"));
        assert_eq!(response.content_blocks.len(), 1);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "tool-1"
        ));
    }

    #[test]
    fn parse_grok_stream_attaches_message_content_tool_results() {
        let input = r#"
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call-1","name":"Read `src/main.ts`","input":{"target_file":"src/main.ts"}},{"type":"text","text":"Done"}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","content":"file contents"}]}}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        assert_eq!(response.content, "Done");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "call-1");
        assert_eq!(
            response.tool_calls[0].output.as_deref(),
            Some("file contents")
        );
        assert_eq!(response.content_blocks.len(), 2);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "call-1"
        ));
        assert!(matches!(
            &response.content_blocks[1],
            ContentBlock::Text { text } if text == "Done"
        ));
    }

    #[test]
    fn acp_tool_output_prefers_readable_raw_output_fields() {
        let output_for_prompt = serde_json::json!({
            "rawOutput": {
                "type": "Bash",
                "output": [105, 103, 110, 111, 114, 101, 100],
                "output_for_prompt": "Exit code: 0\nhello"
            }
        });
        assert_eq!(
            acp_tool_output(&output_for_prompt).as_deref(),
            Some("Exit code: 0\nhello")
        );

        let byte_output = serde_json::json!({
            "rawOutput": {
                "type": "Bash",
                "output": [102, 105, 108, 101, 115]
            }
        });
        assert_eq!(acp_tool_output(&byte_output).as_deref(), Some("files"));
    }

    #[test]
    fn build_grok_agent_args_use_acp_stdio() {
        let args = build_grok_agent_args(
            Some("grok/grok-composer-2.5-fast"),
            Some("yolo"),
            Some("high"),
        );

        assert_eq!(args[0], "--no-auto-update");
        assert!(args.contains(&"agent".to_string()));
        assert!(args.contains(&"stdio".to_string()));
        assert!(!args.contains(&"-p".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"grok-composer-2.5-fast".to_string()));
        assert!(args.contains(&"--reasoning-effort".to_string()));
        assert!(args.contains(&"high".to_string()));
        assert!(args.contains(&"--always-approve".to_string()));
    }

    #[test]
    fn grok_acp_idle_lifecycle_keeps_recent_idle_connections_alive() {
        let last_used = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(300);

        assert!(should_keep_grok_acp_connection_alive(
            last_used,
            false,
            last_used + std::time::Duration::from_secs(299),
            timeout,
        ));
        assert!(should_keep_grok_acp_connection_alive(
            last_used,
            true,
            last_used + std::time::Duration::from_secs(301),
            timeout,
        ));
        assert!(!should_keep_grok_acp_connection_alive(
            last_used,
            false,
            last_used + std::time::Duration::from_secs(301),
            timeout,
        ));
    }
}
