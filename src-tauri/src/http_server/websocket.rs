use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, mpsc};

use super::dispatch::dispatch_command;
use super::{WsBroadcaster, WsEvent};

/// Typed client message parsed from JSON with `"type"` tag.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum WsClientMessage {
    /// Standard command invocation: `{ type: "invoke", id, command, args }`.
    #[serde(rename = "invoke")]
    Invoke {
        id: String,
        command: String,
        #[serde(default)]
        args: Value,
    },
    /// Request replay of missed events after reconnection.
    #[serde(rename = "replay")]
    Replay { session_id: String, last_seq: u64 },
    /// Request replay of missed terminal events after reconnection.
    #[serde(rename = "terminal_replay")]
    TerminalReplay { terminal_id: String, last_seq: u64 },
}

/// Legacy invoke request without `type` field (backwards compat).
#[derive(Deserialize)]
struct InvokeRequest {
    id: String,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Serialize)]
struct InvokeResponse {
    #[serde(rename = "type")]
    msg_type: String,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Handle a single WebSocket connection.
///
/// Architecture (optimised for multi-client streaming):
///
/// 1. **No event forwarder task** — the main select loop reads directly from
///    the broadcast channel, eliminating the intermediate mpsc hop.
///
/// 2. **Command dispatch is spawned** as separate tokio tasks so it never
///    blocks event delivery. Responses come back via an unbounded channel.
///
/// 3. **Batched writes** — after receiving the first message, we drain
///    additional pending messages with `try_recv()` and write them all with
///    `SinkExt::feed()` before a single `SinkExt::flush()`.
///
/// 4. **Events are pre-serialized** (`Arc<str>`) in the broadcast channel,
///    so no per-client JSON work is needed here.
pub async fn handle_ws_connection(
    socket: WebSocket,
    app: AppHandle,
    mut event_rx: broadcast::Receiver<WsEvent>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Channel for command dispatch responses. Unbounded because command
    // responses are infrequent (user-initiated) and must never be dropped.
    let (resp_tx, mut resp_rx) = mpsc::unbounded_channel::<String>();

    // Heartbeat: server-driven protocol ping every PING_INTERVAL. If no
    // inbound traffic (pong, text, ping) for PONG_TIMEOUT, treat connection as
    // dead and break — onclose path on the client triggers reconnect + replay.
    //
    // Also send an app-level heartbeat text frame. Browser JS does not expose
    // protocol ping/pong frames to `WebSocket.onmessage`, so the frontend
    // liveness watchdog needs a normal message during otherwise-idle terminal
    // sessions. Without this, web access reconnects every ~50s of no app
    // events, which makes embedded xterm sessions appear to time out.
    const PING_INTERVAL: Duration = Duration::from_secs(20);
    const PONG_TIMEOUT: Duration = Duration::from_secs(45);
    const APP_HEARTBEAT_JSON: &str = r#"{"type":"heartbeat"}"#;
    let mut ping_interval = tokio::time::interval(PING_INTERVAL);
    ping_interval.tick().await; // skip immediate fire
    let mut last_inbound = Instant::now();

    // Main loop — four event sources, never blocks on command dispatch.
    loop {
        tokio::select! {
            // ── Heartbeat tick ───────────────────────────────────────
            _ = ping_interval.tick() => {
                if last_inbound.elapsed() > PONG_TIMEOUT {
                    log::warn!("WS client idle > {PONG_TIMEOUT:?}, dropping connection");
                    break;
                }
                if ws_tx.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
                if ws_tx
                    .send(Message::Text(APP_HEARTBEAT_JSON.into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }

            // ── Incoming command from client ──────────────────────────
            msg = ws_rx.next() => {
                last_inbound = Instant::now();
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<WsClientMessage>(&text) {
                            Ok(WsClientMessage::Invoke { id, command, args }) => {
                                // Spawn dispatch as a separate task so the
                                // select loop stays free to drain events.
                                let app_clone = app.clone();
                                let tx = resp_tx.clone();
                                tokio::spawn(async move {
                                    let resp = match dispatch_command(
                                        &app_clone,
                                        &command,
                                        args,
                                    )
                                    .await
                                    {
                                        Ok(data) => InvokeResponse {
                                            msg_type: "response".to_string(),
                                            id,
                                            data: Some(data),
                                            error: None,
                                        },
                                        Err(err) => InvokeResponse {
                                            msg_type: "error".to_string(),
                                            id,
                                            data: None,
                                            error: Some(err),
                                        },
                                    };
                                    if let Ok(json) = serde_json::to_string(&resp) {
                                        let _ = tx.send(json);
                                    }
                                });
                            }
                            Ok(WsClientMessage::Replay { session_id, last_seq }) => {
                                // Replay missed events for this session
                                if let Some(broadcaster) = app.try_state::<WsBroadcaster>() {
                                    let events = broadcaster.replay_events(&session_id, last_seq);
                                    for (_seq, json) in events {
                                        if ws_tx.send(Message::Text(json.to_string().into())).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            Ok(WsClientMessage::TerminalReplay { terminal_id, last_seq }) => {
                                // Replay missed terminal events after reconnect
                                if let Some(broadcaster) = app.try_state::<WsBroadcaster>() {
                                    let events = broadcaster.replay_terminal_events(&terminal_id, last_seq);
                                    for (_seq, json) in events {
                                        if ws_tx.send(Message::Text(json.to_string().into())).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                // Try legacy format (no "type" field — old clients send bare invoke)
                                match serde_json::from_str::<InvokeRequest>(&text) {
                                    Ok(req) => {
                                        let app_clone = app.clone();
                                        let tx = resp_tx.clone();
                                        tokio::spawn(async move {
                                            let id = req.id.clone();
                                            let resp = match dispatch_command(
                                                &app_clone,
                                                &req.command,
                                                req.args,
                                            )
                                            .await
                                            {
                                                Ok(data) => InvokeResponse {
                                                    msg_type: "response".to_string(),
                                                    id,
                                                    data: Some(data),
                                                    error: None,
                                                },
                                                Err(err) => InvokeResponse {
                                                    msg_type: "error".to_string(),
                                                    id,
                                                    data: None,
                                                    error: Some(err),
                                                },
                                            };
                                            if let Ok(json) = serde_json::to_string(&resp) {
                                                let _ = tx.send(json);
                                            }
                                        });
                                    }
                                    Err(_) => {
                                        let resp = InvokeResponse {
                                            msg_type: "error".to_string(),
                                            id: "unknown".to_string(),
                                            data: None,
                                            error: Some(format!("Invalid request: {e}")),
                                        };
                                        if let Ok(json) = serde_json::to_string(&resp) {
                                            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        if ws_tx.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {} // liveness already bumped above
                    _ => {} // Ignore binary
                }
            }

            // ── Command response from a spawned dispatch task ────────
            Some(json) = resp_rx.recv() => {
                // Feed this response then drain any other pending messages.
                if feed_and_drain(&mut ws_tx, &mut event_rx, &mut resp_rx, json).await.is_err() {
                    break;
                }
            }

            // ── Broadcast event (direct from broadcast channel) ──────
            result = event_rx.recv() => {
                match result {
                    Ok(first_event) => {
                        if feed_and_drain(&mut ws_tx, &mut event_rx, &mut resp_rx, first_event.json.to_string()).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("WS client lagged, skipped {n} events");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    log::trace!("WebSocket client disconnected");
}

/// Maximum additional messages to drain after the first in a single flush cycle.
const DRAIN_MAX: usize = 32;

/// Feed the first message, then non-blocking drain up to `DRAIN_MAX` more
/// pending messages from both the broadcast and command response channels.
/// Finishes with a single `flush()` to coalesce into fewer syscalls.
async fn feed_and_drain(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event_rx: &mut broadcast::Receiver<WsEvent>,
    resp_rx: &mut mpsc::UnboundedReceiver<String>,
    first: String,
) -> Result<(), axum::Error> {
    ws_tx.feed(Message::Text(first.into())).await?;

    // Non-blocking drain: grab whatever is already pending.
    for _ in 0..DRAIN_MAX {
        // Try broadcast events first (high volume during streaming)
        match event_rx.try_recv() {
            Ok(ev) => {
                ws_tx
                    .feed(Message::Text(ev.json.to_string().into()))
                    .await?;
                continue;
            }
            Err(broadcast::error::TryRecvError::Lagged(n)) => {
                log::warn!("WS client lagged during drain, skipped {n} events");
                continue;
            }
            _ => {}
        }
        // Try command responses
        match resp_rx.try_recv() {
            Ok(json) => {
                ws_tx.feed(Message::Text(json.into())).await?;
                continue;
            }
            Err(_) => break, // Nothing pending — stop draining
        }
    }

    ws_tx.flush().await?;
    Ok(())
}
