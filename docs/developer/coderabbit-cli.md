# CodeRabbit CLI Integration

Jean treats CodeRabbit as a helper CLI for secondary code review, not as a chat backend.

## Settings

The General preferences pane exposes CodeRabbit CLI status, install, login, update, source selection, and managed-install deletion.

- Jean-managed binaries live in app data under `coderabbit-cli/`.
- System PATH detection excludes the Jean-managed binary.
- Latest-version checks read CodeRabbit's official release manifest at `https://cli.coderabbit.ai/releases/latest/VERSION` and cache the result under `coderabbit-cli/coderabbit-versions-cache.json`.
- Login opens the terminal modal with `coderabbit auth login`.

## Review flow

Clicking Review opens a chooser:

- Jean AI review: existing `run_review_with_ai` path.
- CodeRabbit review: `run_coderabbit_review`, which runs `coderabbit review --agent --dir <worktree>`.

The backend parses CodeRabbit JSONL events into the existing `ReviewResponse` shape so `ReviewResultsPanel` and Fix actions can be reused.
