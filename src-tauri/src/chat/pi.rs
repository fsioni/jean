//! PI Coding Agent execution engine.

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
#[cfg(unix)]
use crate::platform::silent_command;
use serde_json::Value;
#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::io::Write;
use std::io::{BufRead, BufReader};
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
use std::process::Stdio;
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
#[cfg(unix)]
use tauri::Manager;

pub const PI_RPC_HOST_ARG: &str = "--jean-pi-rpc-host";

pub struct PiResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
}

#[derive(serde::Serialize, Clone)]
struct ChunkEvent {
    session_id: String,
    worktree_id: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
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
struct ThinkingEvent {
    session_id: String,
    worktree_id: String,
    content: String,
}

#[derive(serde::Serialize, Clone)]
struct DoneEvent {
    session_id: String,
    worktree_id: String,
    waiting_for_plan: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct ErrorEvent {
    pub session_id: String,
    pub worktree_id: String,
    pub error: String,
}

fn normalize_tool_name(name: &str) -> String {
    match name {
        "read" => "Read",
        "write" => "Write",
        "edit" => "Edit",
        "bash" | "shell" | "terminal" => "Bash",
        "grep" | "search" => "Grep",
        "find" | "glob" | "ls" | "list" => "Glob",
        other => other,
    }
    .to_string()
}

fn usage_from_value(value: &Value) -> Option<UsageData> {
    let usage = value.get("usage").or_else(|| value.get("token_usage"))?;
    Some(UsageData {
        input_tokens: usage
            .get("input_tokens")
            .or_else(|| usage.get("inputTokens"))
            .or_else(|| usage.get("input"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: usage
            .get("output_tokens")
            .or_else(|| usage.get("outputTokens"))
            .or_else(|| usage.get("output"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_read_input_tokens: usage
            .get("cache_read_input_tokens")
            .or_else(|| usage.get("cacheReadInputTokens"))
            .or_else(|| usage.get("cacheRead"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_creation_input_tokens: usage
            .get("cache_creation_input_tokens")
            .or_else(|| usage.get("cacheCreationInputTokens"))
            .or_else(|| usage.get("cacheWrite"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

fn iter_content_blocks(value: &Value) -> impl Iterator<Item = &Value> {
    value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn text_content_from_blocks(value: &Value) -> String {
    iter_content_blocks(value)
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn text_delta_from_value(value: &Value) -> Option<&str> {
    value
        .get("assistantMessageEvent")
        .and_then(|event| {
            if event.get("type").and_then(Value::as_str) == Some("text_delta") {
                event.get("delta").and_then(Value::as_str)
            } else {
                None
            }
        })
        .or_else(|| {
            value.get("delta").and_then(|d| {
                if d.get("type").and_then(Value::as_str) == Some("text_delta") {
                    d.get("text").and_then(Value::as_str)
                } else {
                    d.as_str()
                }
            })
        })
        .or_else(|| value.get("text").and_then(Value::as_str))
}

fn message_usage_from_value(value: &Value) -> Option<UsageData> {
    value.get("message").and_then(usage_from_value)
}

fn merge_assistant_message(response: &mut PiResponse, message: &Value) {
    for block in iter_content_blocks(message) {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    response.content.push_str(text);
                    response.content_blocks.push(ContentBlock::Text {
                        text: text.to_string(),
                    });
                }
            }
            Some("thinking") => {
                if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                    response.content_blocks.push(ContentBlock::Thinking {
                        thinking: thinking.to_string(),
                    });
                }
            }
            Some("toolCall") => {
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    continue;
                }
                let raw_name = block.get("name").and_then(Value::as_str).unwrap_or("");
                let input = block
                    .get("arguments")
                    .or_else(|| block.get("input"))
                    .cloned()
                    .unwrap_or(Value::Null);
                response.tool_calls.push(ToolCall {
                    id: id.clone(),
                    name: normalize_tool_name(raw_name),
                    input,
                    output: None,
                    parent_tool_use_id: None,
                });
                response
                    .content_blocks
                    .push(ContentBlock::ToolUse { tool_call_id: id });
            }
            _ => {}
        }
    }
    if let Some(next_usage) = usage_from_value(message) {
        response.usage = Some(next_usage);
    }
}

fn pi_session_id_from_value(value: &Value) -> Option<String> {
    value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .or_else(|| {
            if value.get("type").and_then(Value::as_str) == Some("session") {
                value.get("id")
            } else {
                None
            }
        })
        .or_else(|| {
            if value.get("type").and_then(Value::as_str) == Some("response")
                && value.get("command").and_then(Value::as_str) == Some("get_state")
            {
                value
                    .get("data")
                    .and_then(|data| data.get("sessionId").or_else(|| data.get("session_id")))
            } else {
                None
            }
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
}

/// Merge a single already-parsed PI JSON line into the accumulating response.
///
/// This is the per-line core of PI stream parsing. Both the batch parser
/// (`parse_pi_json_stream_inner`) and the streaming parser (`parse_pi_stream`)
/// call this once per line, so the live stream never re-parses the whole
/// accumulated buffer (avoids O(n²) work on long sessions).
fn merge_pi_line(response: &mut PiResponse, value: &Value) {
    if let Some(id) = pi_session_id_from_value(value) {
        response.session_id = id;
    }

    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "message" => {
            let Some(message) = value.get("message") else {
                return;
            };
            match message.get("role").and_then(Value::as_str) {
                Some("assistant") => {
                    merge_assistant_message(response, message);
                }
                Some("toolResult") => {
                    let id = message
                        .get("toolCallId")
                        .or_else(|| message.get("tool_call_id"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let output = text_content_from_blocks(message);
                    if let Some(tool) = response.tool_calls.iter_mut().find(|tool| tool.id == id) {
                        tool.output = Some(output);
                    }
                }
                _ => {}
            }
        }
        "message_update" => {
            if value.get("role").and_then(Value::as_str) != Some("user") {
                if let Some(text) = text_delta_from_value(value) {
                    response.content.push_str(text);
                    response.content_blocks.push(ContentBlock::Text {
                        text: text.to_string(),
                    });
                }
            }
        }
        "assistant" => {
            if let Some(message) = value.get("message") {
                merge_assistant_message(response, message);
            } else if let Some(text) = text_delta_from_value(value) {
                response.content.push_str(text);
                response.content_blocks.push(ContentBlock::Text {
                    text: text.to_string(),
                });
            }
        }
        "tool_execution_start" | "tool_call" => {
            let id = value
                .get("id")
                .or_else(|| value.get("tool_use_id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                return;
            }
            let raw_name = value
                .get("name")
                .or_else(|| value.get("tool_name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let input = value
                .get("input")
                .or_else(|| value.get("args"))
                .cloned()
                .unwrap_or(Value::Null);
            response.tool_calls.push(ToolCall {
                id: id.clone(),
                name: normalize_tool_name(raw_name),
                input,
                output: None,
                parent_tool_use_id: None,
            });
            response
                .content_blocks
                .push(ContentBlock::ToolUse { tool_call_id: id });
        }
        "tool_execution_end" | "tool_result" => {
            let id = value
                .get("id")
                .or_else(|| value.get("tool_use_id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let output = value
                .get("output")
                .or_else(|| value.get("result"))
                .or_else(|| value.get("content"))
                .map(|v| {
                    v.as_str()
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| v.to_string())
                })
                .unwrap_or_default();
            if let Some(tool) = response.tool_calls.iter_mut().find(|tool| tool.id == id) {
                tool.output = Some(output);
            }
        }
        "message_end" | "turn_end" => {
            if let Some(next_usage) = message_usage_from_value(value) {
                response.usage = Some(next_usage);
            }
        }
        "agent_end" | "result" => {
            if let Some(next_usage) = usage_from_value(value) {
                response.usage = Some(next_usage);
            }
        }
        _ => {}
    }
}

fn empty_pi_response() -> PiResponse {
    PiResponse {
        content: String::new(),
        session_id: String::new(),
        tool_calls: Vec::new(),
        content_blocks: Vec::new(),
        cancelled: false,
        usage: None,
    }
}

fn parse_pi_json_stream_inner(input: &str) -> PiResponse {
    let mut response = empty_pi_response();
    for line in input.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            merge_pi_line(&mut response, &value);
        }
    }
    response
}

fn raw_pi_model(model: Option<&str>) -> Option<&str> {
    model.map(|m| m.strip_prefix("pi/").unwrap_or(m))
}

fn pi_thinking_level(effort: Option<&super::types::EffortLevel>) -> Option<&'static str> {
    match effort {
        Some(super::types::EffortLevel::Off) => Some("off"),
        Some(super::types::EffortLevel::Minimal) => Some("minimal"),
        Some(super::types::EffortLevel::Low) => Some("low"),
        Some(super::types::EffortLevel::Medium) => Some("medium"),
        Some(super::types::EffortLevel::High) => Some("high"),
        Some(super::types::EffortLevel::Xhigh)
        | Some(super::types::EffortLevel::Max)
        | Some(super::types::EffortLevel::Ultracode) => Some("xhigh"),
        None => None,
    }
}

fn pi_tools_for_mode(mode: &str) -> &'static str {
    match mode {
        "plan" => "read,grep,find,ls",
        "build" => "read,grep,find,ls,edit,write",
        _ => "all",
    }
}

fn append_system_prompt_arg(args: &mut Vec<String>, system_prompt: Option<&str>) {
    if let Some(prompt) = system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(prompt.to_string());
    }
}

fn usable_pi_session_id<'a>(
    existing_pi_session_id: Option<&'a str>,
    jean_session_id: &str,
) -> Option<&'a str> {
    let id = existing_pi_session_id
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    if id == jean_session_id {
        None
    } else {
        Some(id)
    }
}

fn build_pi_rpc_args(
    jean_session_id: &str,
    model: Option<&str>,
    execution_mode: Option<&str>,
    effort_level: Option<&super::types::EffortLevel>,
    system_prompt: Option<&str>,
    existing_pi_session_id: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), "rpc".to_string()];
    if let Some(id) = usable_pi_session_id(existing_pi_session_id, jean_session_id) {
        args.push("--session".to_string());
        args.push(id.to_string());
    }
    if let Some(model) = raw_pi_model(model) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(thinking) = pi_thinking_level(effort_level) {
        args.push("--thinking".to_string());
        args.push(thinking.to_string());
    }
    args.push("--tools".to_string());
    args.push(pi_tools_for_mode(execution_mode.unwrap_or("plan")).to_string());
    append_system_prompt_arg(&mut args, system_prompt);
    args
}

pub(crate) fn serialize_pi_rpc_command(
    command_type: &str,
    message: Option<&str>,
    id: Option<&str>,
) -> String {
    let mut value = serde_json::Map::new();
    if let Some(id) = id {
        value.insert("id".to_string(), Value::String(id.to_string()));
    }
    value.insert("type".to_string(), Value::String(command_type.to_string()));
    if let Some(message) = message {
        value.insert("message".to_string(), Value::String(message.to_string()));
    }
    format!("{}\n", Value::Object(value))
}

fn pi_line_is_completion_result(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .is_some_and(|event_type| event_type == "agent_end" || event_type == "result")
}

fn pi_line_session_id(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| pi_session_id_from_value(&value))
}

pub(crate) fn run_id_from_output_file(output_file: &Path) -> String {
    output_file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown-run")
        .to_string()
}

#[cfg(unix)]
pub(crate) fn pi_rpc_socket_path(app_data_dir: &Path, session_id: &str, run_id: &str) -> PathBuf {
    fn short_id(value: &str) -> String {
        let short = value
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(8)
            .collect::<String>();
        if short.is_empty() {
            "unknown".to_string()
        } else {
            short
        }
    }

    app_data_dir.join("r").join(format!(
        "p{}{}.sock",
        short_id(session_id),
        short_id(run_id)
    ))
}

#[cfg(unix)]
fn wait_for_pi_rpc_socket(socket_path: &Path, pid: u32) -> Result<(), String> {
    use crate::platform::is_process_alive;
    use std::os::unix::net::UnixStream;

    let started = Instant::now();
    let timeout = Duration::from_secs(15);
    loop {
        if UnixStream::connect(socket_path).is_ok() {
            return Ok(());
        }
        if !is_process_alive(pid) {
            return Err(format!(
                "PI RPC host exited before socket became ready: {}",
                socket_path.display()
            ));
        }
        if started.elapsed() > timeout {
            return Err(format!(
                "Timed out waiting for PI RPC host socket at {}",
                socket_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
pub(crate) fn send_pi_rpc_host_command(socket_path: &Path, line: &str) -> Result<(), String> {
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket_path)
        .map_err(|e| format!("Failed to connect to PI RPC host: {e}"))?;
    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write PI RPC host command: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("Failed to flush PI RPC host command: {e}"))?;
    Ok(())
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn spawn_pi_rpc_host(
    app: &AppHandle,
    session_id: &str,
    run_id: &str,
    output_file: &Path,
    working_dir: &Path,
    cli_path: &Path,
    pi_args: &[String],
) -> Result<(u32, PathBuf), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let socket_path = pi_rpc_socket_path(&app_data, session_id, run_id);
    if let Some(socket_dir) = socket_path.parent() {
        std::fs::create_dir_all(socket_dir)
            .map_err(|e| format!("Failed to create PI RPC socket dir: {e}"))?;
    }
    let _ = std::fs::remove_file(&socket_path);

    let log_dir = app_data.join("pi-rpc-hosts");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create PI RPC host log dir: {e}"))?;
    let log_file = log_dir.join(format!("{session_id}-{run_id}.log"));
    let exe = std::env::current_exe().map_err(|e| format!("Failed to get Jean executable: {e}"))?;

    let mut args = vec![
        PI_RPC_HOST_ARG.to_string(),
        "--socket".to_string(),
        socket_path.to_string_lossy().to_string(),
        "--output".to_string(),
        output_file.to_string_lossy().to_string(),
        "--cwd".to_string(),
        working_dir.to_string_lossy().to_string(),
        "--pi-cli".to_string(),
        cli_path.to_string_lossy().to_string(),
    ];
    for arg in pi_args {
        args.push("--pi-arg".to_string());
        args.push(arg.clone());
    }

    let pid = super::detached::spawn_detached_process(&exe, &args, &log_file, &app_data)?;
    wait_for_pi_rpc_socket(&socket_path, pid)?;
    Ok((pid, socket_path))
}

#[cfg(unix)]
pub fn run_pi_rpc_host_from_args() -> Result<(), String> {
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::process::ChildStdin;

    let mut socket_path: Option<PathBuf> = None;
    let mut output_file: Option<PathBuf> = None;
    let mut cwd: Option<PathBuf> = None;
    let mut pi_cli: Option<PathBuf> = None;
    let mut pi_args: Vec<String> = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket_path = args.next().map(PathBuf::from),
            "--output" => output_file = args.next().map(PathBuf::from),
            "--cwd" => cwd = args.next().map(PathBuf::from),
            "--pi-cli" => pi_cli = args.next().map(PathBuf::from),
            "--pi-arg" => {
                if let Some(value) = args.next() {
                    pi_args.push(value);
                }
            }
            _ => {}
        }
    }

    let socket_path = socket_path.ok_or("--socket is required")?;
    let output_file = output_file.ok_or("--output is required")?;
    let cwd = cwd.ok_or("--cwd is required")?;
    let pi_cli = pi_cli.ok_or("--pi-cli is required")?;

    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create PI RPC socket directory: {e}"))?;
    }
    if let Some(parent) = output_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create PI output directory: {e}"))?;
    }
    let output = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&output_file)
            .map_err(|e| format!("Failed to open PI output file: {e}"))?,
    ));

    let mut child = silent_command(&pi_cli)
        .args(&pi_args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn PI RPC child: {e}"))?;

    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture PI RPC stdin".to_string())?;
    let stdin_writer: Arc<Mutex<ChildStdin>> = Arc::new(Mutex::new(child_stdin));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture PI RPC stdout".to_string())?;

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[pi-rpc] {line}");
            }
        });
    }

    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)
        .map_err(|e| format!("Failed to bind PI RPC host socket: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set PI RPC socket nonblocking: {e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let listener_stop = stop.clone();
    let listener_stdin = stdin_writer.clone();
    std::thread::spawn(move || {
        fn handle_client(stream: UnixStream, stdin_writer: Arc<Mutex<ChildStdin>>) {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(mut stdin) = stdin_writer.lock() {
                    let _ = stdin.write_all(line.as_bytes());
                    let _ = stdin.write_all(b"\n");
                    let _ = stdin.flush();
                }
            }
        }

        while !listener_stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let stdin = listener_stdin.clone();
                    std::thread::spawn(move || handle_client(stream, stdin));
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(e) => {
                    eprintln!("[pi-rpc-host] listener error: {e}");
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });

    let get_state_line = serialize_pi_rpc_command("get_state", None, Some("jean-get-state"));
    {
        let mut stdin = stdin_writer
            .lock()
            .map_err(|_| "PI stdin lock poisoned".to_string())?;
        stdin
            .write_all(get_state_line.as_bytes())
            .map_err(|e| format!("Failed to write PI RPC get_state command: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("Failed to flush PI RPC get_state command: {e}"))?;
    }

    let mut pi_session_id: Option<String> = None;
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Failed to read PI RPC stdout: {e}"))?;
        if let Some(id) = pi_line_session_id(&line) {
            pi_session_id = Some(id);
        }
        {
            let mut out = output
                .lock()
                .map_err(|_| "PI output file lock poisoned".to_string())?;
            writeln!(out, "{line}").map_err(|e| format!("Failed to write PI output: {e}"))?;
            out.flush()
                .map_err(|e| format!("Failed to flush PI output: {e}"))?;
        }
        if pi_line_is_completion_result(&line) {
            let result = serde_json::json!({
                "type": "result",
                "session_id": pi_session_id,
            });
            let mut out = output
                .lock()
                .map_err(|_| "PI output file lock poisoned".to_string())?;
            writeln!(out, "{result}")
                .map_err(|e| format!("Failed to write PI result marker: {e}"))?;
            out.flush()
                .map_err(|e| format!("Failed to flush PI result marker: {e}"))?;
            break;
        }
    }

    stop.store(true, Ordering::SeqCst);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&socket_path);
    Ok(())
}

#[cfg(not(unix))]
pub fn run_pi_rpc_host_from_args() -> Result<(), String> {
    Err("PI RPC host is only supported on Unix-like systems".to_string())
}

fn parse_pi_stream<R: BufRead>(
    app: Option<&AppHandle>,
    session_id: &str,
    worktree_id: &str,
    run_id: Option<&str>,
    reader: R,
) -> Result<PiResponse, String> {
    let mut response = empty_pi_response();

    for line in reader.lines() {
        let line = line.map_err(|e| format!("Failed to read PI output: {e}"))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        let before_content_len = response.content.len();
        let before_tool_count = response.tool_calls.len();
        // Merge only this line — no re-parse of the whole accumulated buffer.
        merge_pi_line(&mut response, &value);

        if let Some(app) = app {
            if response.content.len() > before_content_len {
                let content = response.content[before_content_len..].to_string();
                let _ = app.emit_all(
                    "chat:chunk",
                    &ChunkEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        content,
                        run_id: run_id.map(ToOwned::to_owned),
                    },
                );
            }
            if response.tool_calls.len() > before_tool_count {
                for tool in &response.tool_calls[before_tool_count..] {
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            input: tool.input.clone(),
                            parent_tool_use_id: tool.parent_tool_use_id.clone(),
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool.id.clone(),
                        },
                    );
                }
            }
            if matches!(
                value.get("type").and_then(Value::as_str),
                Some("tool_execution_end" | "tool_result")
            ) {
                if let Some(tool_id) = value
                    .get("id")
                    .or_else(|| value.get("tool_use_id"))
                    .and_then(Value::as_str)
                {
                    if let Some(tool) = response.tool_calls.iter().find(|tool| tool.id == tool_id) {
                        if let Some(output) = &tool.output {
                            let _ = app.emit_all(
                                "chat:tool_result",
                                &ToolResultEvent {
                                    session_id: session_id.to_string(),
                                    worktree_id: worktree_id.to_string(),
                                    tool_use_id: tool_id.to_string(),
                                    output: output.clone(),
                                },
                            );
                        }
                    }
                }
            }
            if let Some(thinking) = value
                .get("delta")
                .and_then(|d| {
                    if d.get("type").and_then(Value::as_str) == Some("thinking_delta") {
                        d.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .or_else(|| value.get("thinking").and_then(Value::as_str))
            {
                let _ = app.emit_all(
                    "chat:thinking",
                    &ThinkingEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        content: thinking.to_string(),
                    },
                );
            }
        }
    }

    Ok(response)
}

fn emit_pi_delta_events(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: Option<&str>,
    value: &Value,
    response: &PiResponse,
    before_content_len: usize,
    before_tool_count: usize,
) {
    if response.content.len() > before_content_len {
        let content = response.content[before_content_len..].to_string();
        let _ = app.emit_all(
            "chat:chunk",
            &ChunkEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                content,
                run_id: run_id.map(ToOwned::to_owned),
            },
        );
    }
    if response.tool_calls.len() > before_tool_count {
        for tool in &response.tool_calls[before_tool_count..] {
            let _ = app.emit_all(
                "chat:tool_use",
                &ToolUseEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    id: tool.id.clone(),
                    name: tool.name.clone(),
                    input: tool.input.clone(),
                    parent_tool_use_id: tool.parent_tool_use_id.clone(),
                },
            );
            let _ = app.emit_all(
                "chat:tool_block",
                &ToolBlockEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    tool_call_id: tool.id.clone(),
                },
            );
        }
    }
    if matches!(
        value.get("type").and_then(Value::as_str),
        Some("tool_execution_end" | "tool_result")
    ) {
        if let Some(tool_id) = value
            .get("id")
            .or_else(|| value.get("tool_use_id"))
            .and_then(Value::as_str)
        {
            if let Some(tool) = response.tool_calls.iter().find(|tool| tool.id == tool_id) {
                if let Some(output) = &tool.output {
                    let _ = app.emit_all(
                        "chat:tool_result",
                        &ToolResultEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_use_id: tool_id.to_string(),
                            output: output.clone(),
                        },
                    );
                }
            }
        }
    }
    if let Some(thinking) = value
        .get("delta")
        .and_then(|d| {
            if d.get("type").and_then(Value::as_str) == Some("thinking_delta") {
                d.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .or_else(|| value.get("thinking").and_then(Value::as_str))
    {
        let _ = app.emit_all(
            "chat:thinking",
            &ThinkingEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                content: thinking.to_string(),
            },
        );
    }
}

pub fn tail_pi_output(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &Path,
    pid: u32,
) -> Result<PiResponse, String> {
    use super::tail::{NdjsonTailer, POLL_INTERVAL, POLL_INTERVAL_FAST};
    use crate::platform::is_process_alive;

    let mut tailer = NdjsonTailer::new_from_start(output_file)?;
    let mut response = empty_pi_response();
    let run_id = output_file.file_stem().and_then(|stem| stem.to_str());
    let started_at = Instant::now();
    let startup_timeout = Duration::from_secs(120);
    let dead_process_timeout = Duration::from_secs(2);
    let mut last_output_at = Instant::now();
    let mut received_output = false;
    let mut completed = false;
    let mut cancelled = false;

    loop {
        let lines = tailer.poll()?;
        let got_lines = !lines.is_empty();
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            if pi_line_is_completion_result(&line) {
                completed = true;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let before_content_len = response.content.len();
            let before_tool_count = response.tool_calls.len();
            merge_pi_line(&mut response, &value);
            emit_pi_delta_events(
                app,
                session_id,
                worktree_id,
                run_id,
                &value,
                &response,
                before_content_len,
                before_tool_count,
            );
            received_output = true;
            last_output_at = Instant::now();
        }

        if completed {
            break;
        }

        let process_alive = is_process_alive(pid);
        if !process_alive {
            if !received_output && started_at.elapsed() > startup_timeout {
                cancelled = true;
                break;
            }
            if received_output && last_output_at.elapsed() > dead_process_timeout {
                cancelled = true;
                break;
            }
        }

        std::thread::sleep(if got_lines {
            POLL_INTERVAL_FAST
        } else {
            POLL_INTERVAL
        });
    }

    response.cancelled = cancelled && !completed;
    if !response.cancelled {
        let _ = app.emit_all(
            "chat:done",
            &DoneEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                waiting_for_plan: false,
            },
        );
    }
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
pub fn execute_pi(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &Path,
    working_dir: &Path,
    existing_pi_session_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    effort_level: Option<&super::types::EffortLevel>,
    message: &str,
    system_prompt: Option<&str>,
    pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
) -> Result<PiResponse, String> {
    let cli_path = crate::pi_cli::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("PI CLI not installed".to_string());
    }

    #[cfg(unix)]
    {
        let run_id = run_id_from_output_file(output_file);
        let resume_pi_session_id = usable_pi_session_id(existing_pi_session_id, session_id);
        let pi_args = build_pi_rpc_args(
            session_id,
            model,
            execution_mode,
            effort_level,
            system_prompt,
            existing_pi_session_id,
        );
        log::info!(
            "[PI] spawning RPC host session={session_id} worktree={worktree_id} model={:?} mode={:?} tools={}",
            raw_pi_model(model),
            execution_mode,
            pi_tools_for_mode(execution_mode.unwrap_or("plan"))
        );
        let (pid, socket_path) = spawn_pi_rpc_host(
            app,
            session_id,
            &run_id,
            output_file,
            working_dir,
            &cli_path,
            &pi_args,
        )?;
        if let Some(callback) = pid_callback {
            callback(pid);
        }
        if !super::registry::register_detached_process(session_id.to_string(), pid) {
            return Ok(PiResponse {
                content: String::new(),
                session_id: resume_pi_session_id.unwrap_or_default().to_string(),
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: true,
                usage: None,
            });
        }

        let prompt_line =
            serialize_pi_rpc_command("prompt", Some(message), Some(&format!("prompt-{run_id}")));
        if let Err(e) = send_pi_rpc_host_command(&socket_path, &prompt_line) {
            super::registry::unregister_process(session_id);
            let _ = crate::platform::kill_process_tree(pid);
            let _ = crate::platform::kill_process(pid);
            return Err(e);
        }

        super::increment_tailer_count();
        let mut response = match tail_pi_output(app, session_id, worktree_id, output_file, pid) {
            Ok(response) => response,
            Err(e) => {
                super::decrement_tailer_count();
                super::registry::unregister_process(session_id);
                return Err(e);
            }
        };
        super::decrement_tailer_count();
        super::registry::unregister_process(session_id);
        if response.session_id == session_id {
            response.session_id.clear();
        }
        if response.session_id.is_empty() {
            response.session_id = resume_pi_session_id.unwrap_or_default().to_string();
        }
        Ok(response)
    }

    #[cfg(not(unix))]
    {
        use std::io::Read as _;

        let run_id = run_id_from_output_file(output_file);
        let mut args = vec!["--mode".to_string(), "json".to_string()];
        let resume_pi_session_id = usable_pi_session_id(existing_pi_session_id, session_id);
        if let Some(id) = resume_pi_session_id {
            args.push("--session".to_string());
            args.push(id.to_string());
        }
        if let Some(model) = raw_pi_model(model) {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
        let pi_thinking = pi_thinking_level(effort_level);
        if let Some(thinking) = pi_thinking {
            args.push("--thinking".to_string());
            args.push(thinking.to_string());
        }
        args.push("--tools".to_string());
        args.push(pi_tools_for_mode(execution_mode.unwrap_or("plan")).to_string());
        append_system_prompt_arg(&mut args, system_prompt);
        args.push(message.to_string());

        log::info!(
        "[PI] spawning session={session_id} worktree={worktree_id} model={:?} mode={:?} thinking={:?} tools={}",
        raw_pi_model(model),
        execution_mode,
        pi_thinking,
        pi_tools_for_mode(execution_mode.unwrap_or("plan"))
    );

        let mut child =
            crate::platform::cli_command(&cli_path.to_string_lossy(), Some(working_dir))
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env("JEAN_SESSION_ID", session_id)
                .env("JEAN_WORKTREE_ID", worktree_id)
                .spawn()
                .map_err(|e| format!("Failed to spawn PI CLI: {e}"))?;
        let pid = child.id();
        if let Some(callback) = pid_callback {
            callback(pid);
        }
        if !super::registry::register_process(session_id.to_string(), pid) {
            return Ok(PiResponse {
                content: String::new(),
                session_id: resume_pi_session_id.unwrap_or_default().to_string(),
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: true,
                usage: None,
            });
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture PI stdout".to_string())?;
        let stderr_handle = child.stderr.take().map(|mut stderr| {
            std::thread::spawn(move || {
                let mut buf = String::new();
                let _ = stderr.read_to_string(&mut buf);
                buf
            })
        });

        let mut response = parse_pi_stream(
            Some(app),
            session_id,
            worktree_id,
            Some(&run_id),
            BufReader::new(stdout),
        )?;
        let status = child
            .wait()
            .map_err(|e| format!("Failed to wait for PI CLI: {e}"))?;
        let cancelled = !super::registry::is_process_running(session_id);
        super::registry::unregister_process(session_id);
        response.cancelled = cancelled;

        if response.session_id == session_id {
            response.session_id.clear();
        }
        if response.session_id.is_empty() {
            response.session_id = resume_pi_session_id.unwrap_or_default().to_string();
        }

        if !status.success() && !cancelled {
            let stderr = stderr_handle
                .and_then(|h| h.join().ok())
                .unwrap_or_default();
            let error = if stderr.trim().is_empty() {
                "PI CLI exited with a non-zero status".to_string()
            } else {
                stderr.trim().to_string()
            };
            let _ = app.emit_all(
                "chat:error",
                &ErrorEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    error: error.clone(),
                },
            );
            return Err(error);
        }

        if !cancelled {
            let _ = app.emit_all(
                "chat:done",
                &DoneEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    waiting_for_plan: response
                        .tool_calls
                        .iter()
                        .any(|tool| tool.name == "ExitPlanMode"),
                },
            );
        }

        Ok(response)
    }
}

pub fn execute_one_shot_pi(
    app: &AppHandle,
    prompt: &str,
    model: &str,
    working_dir: Option<&Path>,
    effort_level: Option<&str>,
) -> Result<String, String> {
    let cli_path = crate::pi_cli::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("PI CLI not installed".to_string());
    }
    let dir = working_dir.unwrap_or_else(|| Path::new("."));
    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), Some(dir));
    cmd.args(["--mode", "json", "--no-session"]);
    cmd.args(["--model", raw_pi_model(Some(model)).unwrap_or(model)]);
    if let Some(effort) = effort_level {
        cmd.args(["--thinking", effort]);
    }
    cmd.arg(prompt)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run PI one-shot request: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "PI one-shot request failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let response = parse_pi_stream(None, "", "", None, BufReader::new(output.stdout.as_slice()))?;
    if response.content.trim().is_empty() {
        return Err("No text content found in PI response".to_string());
    }
    Ok(response.content.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pi_json_mode_message_update_deltas() {
        let stream = r#"
{"type":"session","version":3,"id":"pi-json-mode-session","timestamp":"2026-06-08T08:43:06.173Z","cwd":"/tmp/project"}
{"type":"message_start","message":{"role":"assistant","content":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello","partial":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"!","partial":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}],"usage":{"input":2531,"output":11,"cacheRead":1,"cacheWrite":2}}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}],"usage":{"input":2531,"output":11,"cacheRead":1,"cacheWrite":2}},"toolResults":[]}
"#;

        let response = parse_pi_json_stream_inner(stream);

        assert_eq!(response.session_id, "pi-json-mode-session");
        assert_eq!(response.content, "Hello!");
        assert_eq!(response.content_blocks.len(), 2);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::Text { text } if text == "Hello"
        ));
        assert!(matches!(
            &response.content_blocks[1],
            ContentBlock::Text { text } if text == "!"
        ));
        let usage = response.usage.unwrap();
        assert_eq!(usage.input_tokens, 2531);
        assert_eq!(usage.output_tokens, 11);
        assert_eq!(usage.cache_read_input_tokens, 1);
        assert_eq!(usage.cache_creation_input_tokens, 2);
    }

    #[test]
    fn parses_native_pi_message_jsonl() {
        let stream = r#"
{"type":"session","version":3,"id":"019ea639-cda3-7de3-9a29-2b8ff0e154db","timestamp":"2026-06-08T07:54:26.595Z","cwd":"/tmp/project"}
{"type":"message","id":"user-1","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1780905266609}}
{"type":"message","id":"assistant-1","message":{"role":"assistant","content":[{"type":"text","text":"Hello! How can I help with the project?","textSignature":"sig"}],"usage":{"input":4135,"output":17,"cacheRead":3,"cacheWrite":5}}}
"#;

        let response = parse_pi_json_stream_inner(stream);

        assert_eq!(response.session_id, "019ea639-cda3-7de3-9a29-2b8ff0e154db");
        assert_eq!(response.content, "Hello! How can I help with the project?");
        assert_eq!(response.content_blocks.len(), 1);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::Text { text } if text == "Hello! How can I help with the project?"
        ));
        let usage = response.usage.unwrap();
        assert_eq!(usage.input_tokens, 4135);
        assert_eq!(usage.output_tokens, 17);
        assert_eq!(usage.cache_read_input_tokens, 3);
        assert_eq!(usage.cache_creation_input_tokens, 5);
    }

    #[test]
    fn parses_top_level_pi_assistant_message_content() {
        let stream = r#"
{"type":"session","version":3,"id":"pi-top-level-assistant","timestamp":"2026-06-11T16:42:26.954Z","cwd":"/tmp/project"}
{"type":"assistant","message":{"content":[{"type":"text","text":"1"}],"usage":{"input":3446,"output":5,"cacheRead":0,"cacheWrite":0}}}
"#;

        let response = parse_pi_json_stream_inner(stream);

        assert_eq!(response.session_id, "pi-top-level-assistant");
        assert_eq!(response.content, "1");
        assert_eq!(response.content_blocks.len(), 1);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::Text { text } if text == "1"
        ));
        let usage = response.usage.unwrap();
        assert_eq!(usage.input_tokens, 3446);
        assert_eq!(usage.output_tokens, 5);
        assert_eq!(usage.cache_read_input_tokens, 0);
        assert_eq!(usage.cache_creation_input_tokens, 0);
    }

    #[test]
    fn parses_native_pi_tool_calls_thinking_and_results() {
        let stream = r#"
{"type":"session","version":3,"id":"pi-session-tools","timestamp":"2026-06-08T07:54:26.595Z","cwd":"/tmp/project"}
{"type":"message","id":"assistant-1","parentId":null,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"Need inspect file."},{"type":"toolCall","id":"call_123","name":"read","arguments":{"path":"README.md"}}],"usage":{"input":10,"output":2,"cacheRead":0,"cacheWrite":0}}}
{"type":"message","id":"tool-1","parentId":"assistant-1","message":{"role":"toolResult","toolCallId":"call_123","toolName":"read","content":[{"type":"text","text":"file contents"}],"isError":false}}
{"type":"message","id":"assistant-2","parentId":"tool-1","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"usage":{"input":11,"output":3,"cacheRead":1,"cacheWrite":2}}}
"#;

        let response = parse_pi_json_stream_inner(stream);

        assert_eq!(response.content, "Done.");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "call_123");
        assert_eq!(response.tool_calls[0].name, "Read");
        assert_eq!(
            response.tool_calls[0].input,
            serde_json::json!({"path":"README.md"})
        );
        assert_eq!(
            response.tool_calls[0].output.as_deref(),
            Some("file contents")
        );
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::Thinking { thinking } if thinking == "Need inspect file."
        ));
        assert!(matches!(
            &response.content_blocks[1],
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "call_123"
        ));
        assert!(matches!(
            &response.content_blocks[2],
            ContentBlock::Text { text } if text == "Done."
        ));
        let usage = response.usage.unwrap();
        assert_eq!(usage.input_tokens, 11);
        assert_eq!(usage.output_tokens, 3);
        assert_eq!(usage.cache_read_input_tokens, 1);
        assert_eq!(usage.cache_creation_input_tokens, 2);
    }

    #[test]
    fn parses_pi_text_tool_and_usage_events() {
        let stream = r#"
{"type":"session","session_id":"pi-session-1"}
{"type":"message_update","role":"assistant","delta":{"type":"text_delta","text":"hello "}}
{"type":"tool_execution_start","id":"tool-1","name":"read","input":{"path":"README.md"}}
{"type":"tool_execution_end","id":"tool-1","output":"ok"}
{"type":"message_update","role":"assistant","delta":{"type":"text_delta","text":"world"}}
{"type":"agent_end","usage":{"input_tokens":10,"output_tokens":20}}
"#;

        let response = parse_pi_json_stream_inner(stream);

        assert_eq!(response.session_id, "pi-session-1");
        assert_eq!(response.content, "hello world");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "tool-1");
        assert_eq!(response.tool_calls[0].name, "Read");
        assert_eq!(response.tool_calls[0].output.as_deref(), Some("ok"));
        assert_eq!(response.content_blocks.len(), 3);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::Text { text } if text == "hello "
        ));
        assert!(matches!(
            &response.content_blocks[1],
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "tool-1"
        ));
        assert!(matches!(
            &response.content_blocks[2],
            ContentBlock::Text { text } if text == "world"
        ));
        assert_eq!(response.usage.as_ref().unwrap().input_tokens, 10);
        assert_eq!(response.usage.as_ref().unwrap().output_tokens, 20);
    }

    #[test]
    fn parses_pi_session_id_from_rpc_get_state_response() {
        let stream = r#"
{"id":"jean-get-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"pi-rpc-session-123","messageCount":0}}
{"type":"message_update","role":"assistant","delta":{"type":"text_delta","text":"remembered"}}
{"type":"agent_end","messages":[]}
"#;

        let response = parse_pi_json_stream_inner(stream);

        assert_eq!(response.session_id, "pi-rpc-session-123");
        assert_eq!(response.content, "remembered");
    }

    #[test]
    fn pi_line_session_id_reads_rpc_get_state_response() {
        let line = r#"{"type":"response","command":"get_state","success":true,"data":{"sessionId":"pi-rpc-session-456"}}"#;

        assert_eq!(
            pi_line_session_id(line).as_deref(),
            Some("pi-rpc-session-456")
        );
    }

    #[test]
    fn pi_rpc_agent_end_counts_as_completion_result() {
        let line = r#"{"type":"agent_end","messages":[]}"#;

        assert!(pi_line_is_completion_result(line));
    }

    #[test]
    fn serializes_pi_rpc_command_as_lf_jsonl() {
        let line = serialize_pi_rpc_command("steer", Some("Stop and inspect tests"), Some("req-1"));

        assert!(line.ends_with('\n'));
        assert!(!line[..line.len() - 1].contains('\n'));
        let value: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(value.get("id").and_then(Value::as_str), Some("req-1"));
        assert_eq!(value.get("type").and_then(Value::as_str), Some("steer"));
        assert_eq!(
            value.get("message").and_then(Value::as_str),
            Some("Stop and inspect tests")
        );
    }

    #[test]
    fn serializes_pi_rpc_get_state_without_message() {
        let line = serialize_pi_rpc_command("get_state", None, Some("jean-get-state"));

        assert!(line.ends_with('\n'));
        let value: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            value.get("id").and_then(Value::as_str),
            Some("jean-get-state")
        );
        assert_eq!(value.get("type").and_then(Value::as_str), Some("get_state"));
        assert!(value.get("message").is_none());
    }

    #[test]
    fn builds_pi_rpc_args_without_prompt_argv() {
        let args = build_pi_rpc_args(
            "jean-session-123",
            Some("pi/openai-codex/gpt-5.4"),
            Some("build"),
            Some(&super::super::types::EffortLevel::High),
            Some("System instructions"),
            Some("pi-session-123"),
        );

        assert!(args.windows(2).any(|w| w == ["--mode", "rpc"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["--session", "pi-session-123"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["--model", "openai-codex/gpt-5.4"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["--tools", "read,grep,find,ls,edit,write"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["--append-system-prompt", "System instructions"]));
        assert_eq!(args.first().map(String::as_str), Some("--mode"));
        assert_eq!(args.get(1).map(String::as_str), Some("rpc"));
    }

    #[test]
    fn pi_rpc_args_do_not_resume_with_jean_session_id() {
        let args = build_pi_rpc_args(
            "a8200218-d1ae-47c2-b69e-9943c5b6baa6",
            Some("pi/openai-codex/gpt-5.5"),
            Some("plan"),
            None,
            None,
            Some("a8200218-d1ae-47c2-b69e-9943c5b6baa6"),
        );

        assert!(!args.iter().any(|arg| arg == "--session"));
    }

    #[cfg(unix)]
    #[test]
    fn pi_rpc_socket_path_lives_under_app_data_with_short_name() {
        let app_data = Path::new("/Users/heyandras/Library/Application Support/com.jean.desktop");
        let socket_path = pi_rpc_socket_path(
            app_data,
            "b1c8040f-8e62-48b7-b915-36c2bac0e1de",
            "1489571e-fdd5-45ed-a1b9-bf0ba4943924",
        );

        assert!(socket_path.starts_with(app_data));
        let expected_parent = app_data.join("r");
        assert_eq!(socket_path.parent(), Some(expected_parent.as_path()));
        assert!(socket_path.to_string_lossy().len() < 104);
    }

    #[test]
    fn maps_effort_levels_to_pi_thinking_levels() {
        use super::super::types::EffortLevel;

        assert_eq!(pi_thinking_level(Some(&EffortLevel::Off)), Some("off"));
        assert_eq!(
            pi_thinking_level(Some(&EffortLevel::Minimal)),
            Some("minimal")
        );
        assert_eq!(pi_thinking_level(Some(&EffortLevel::Low)), Some("low"));
        assert_eq!(
            pi_thinking_level(Some(&EffortLevel::Medium)),
            Some("medium")
        );
        assert_eq!(pi_thinking_level(Some(&EffortLevel::High)), Some("high"));
        assert_eq!(pi_thinking_level(Some(&EffortLevel::Xhigh)), Some("xhigh"));
        assert_eq!(pi_thinking_level(None), None);
    }
}
