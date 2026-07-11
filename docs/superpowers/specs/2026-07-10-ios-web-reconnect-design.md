# iOS Web Access Reconnection Design

## Goal

Make Jean feel immediately usable when iOS resumes web access after background suspension, while restoring the live backend connection safely.

## Design

- Keep cached UI visible during reconnects and show a compact status banner.
- Continue gating backend commands through the existing WebSocket availability state.
- Do not start reconnect bootstrap requests while the document is hidden.
- On foreground, immediately replace a socket whose last inbound message is older than the liveness timeout; keep a recent socket.
- Reset reconnect backoff on foreground and rely on the existing connection guard to deduplicate `visibilitychange`, `pageshow`, and `online` wake events.
- After the WebSocket opens, refresh persisted state silently and replay buffered chat and terminal events.

## Failure Handling

- Cached navigation and content remain available while offline.
- Failed bootstrap refreshes fall back to query invalidation without covering the UI.
- Authentication failures continue to use the blocking authentication screen.

## Tests

- Hidden pages do not prefetch reconnect bootstrap data.
- A stale open socket is closed immediately on foreground.
- The app renders the cached main window with a non-blocking reconnect banner.
- Existing replay, heartbeat, and reconnect tests remain green.
