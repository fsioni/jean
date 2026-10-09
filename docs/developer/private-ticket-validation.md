# Private ticket validation

The AI Pipeline offers two pickup actions: **Récupérer** keeps the existing
worktree/assignment workflow; **Récupérer et valider** starts a private validation
only after the pickup succeeds. Validation is followed directly on its worktree in the Projects canvas. Finishing/merging remains a separate manual action.

## Ownership and boundaries

Rust owns the orchestration job. React starts it, polls snapshots through the
shared transport, and offers pause/resume. Browser disconnects do not own or
cancel the job. Closing the modal does not stop an agent. Pausing prevents the
next step and never cancels a Jean chat session or its Run environment.

Backend implementation lives in `jean-core/src/ai_pipeline/`:

- `validation_types.rs`: versioned snake_case persisted state and result contract.
- `validation_engine.rs`: pure state transitions and proof/readiness invariants.
- `validation_storage.rs`: private snapshots, atomic replacement, durability.
- `validation_artifacts.rs`: bounded artifact validation and private durable copies.
- `validation_lab.rs`: targetless offline scenarios using the real engine/parser/store and selected command boundaries.
- `validation_orchestration.rs`: shared canonical-owner, recovery and run-binding guards.
- `validation_ci.rs`: exact PR/head checks requiring the known Planexpo Jenkins context.
- `validation_commands.rs`: job ownership, external effect reconciliation and IPC.
- `validation_steps.rs`: agent instructions, strict result parsing and Git sync.
- `validation_publication.rs`: reviewed-head publication and idempotent PR creation.
- `runtime_config.rs`: proven setup configuration baseline and protected staging.
- `preview_version.rs`: bounded `/version` reads and Git ancestry verification.

Commands are dispatched through `jean-core/src/http_server/dispatch.rs`; native
IPC uses `dispatch_core_command`, so the same implementation serves native,
Web Access and mobile. Do not add a frontend-owned workflow loop.

## Workflow

Review → optional correction/tests → independent review → Git sync → CI →
preview version → acceptance testing → ready for the user's decision.

For a ticket without a PR or remote branch, the same action starts with
implementation/tests → independent review → optional correction/review → first
Git sync → PR creation/assignment → CI → preview → acceptance. Agents never
commit or publish: backend commit/push/PR operations follow persisted intent.
Initial implementation is not a successful review or recipe and cannot mark ready.

The first push requires a successful fetch, the current remote base to be an
ancestor of the reviewed commit, a clean attributable tree and an unchanged
branch/HEAD. Ambiguous/divergent bases block; no merge or force-push is attempted.
Fetch/push destinations must be unique and identical, are bound privately across
recovery, and explicit captured destinations are used for publication.
PR creation reconciles repository/head/base/SHA before retrying, checks remote
head, and refuses multiple, closed, foreign-owned or differently bound PRs.
The public title/body describe the ticket only, not private findings or automation.
PR identity is attached to the worktree under the project storage lock, and guarded
self-assignment is confirmed before CI. Interrupted publication resumes without
silently creating a second PR or rerunning implementation.

A functional failure found during acceptance returns to correction, then independent
review, Git sync, CI, preview verification and a new acceptance pass. Failed mandatory
criteria cannot be hidden by an agent's `passed` summary. This loop shares the same
global correction limits as review/CI findings; acceptance does not reset them.
Missing evidence, unavailable tools, external waits and ambiguous technical failures
do not trigger blind code changes.

The review score is not a gate. Mandatory unresolved defects trigger correction;
missing acceptance evidence does not by itself trigger code correction. At most
three correction attempts are allowed, with an earlier stop after two attempts
without progress on existing stable obligations. Waiting does not count as a
correction. A successful Review stage is not global Ready: mandatory CI or
acceptance criteria may remain Unverified while Review advances to Git sync,
CI, preview and acceptance. Only unresolved mandatory functional failures send
that review back to correction; missing future-stage evidence must not trap it
in a review waiting loop. Fresh CI, preview and acceptance proofs remain mandatory
before Ready.

Review must return a non-waiting decision. A Review `waiting` result is a contract
error, not an external deployment wait: the first occurrence schedules exactly
one immediate targeted repair retry at Review (Pending), with its budget persisted
across recovery. A second occurrence blocks fail-closed for intervention. Neither
occurrence increments correction/no-progress counters or starts a 60-second wait.
This exception does not weaken genuine external CI/preview waits: they retain a
persisted start time and a 30-minute ceiling.

Exactly one non-superseded execution owns a worktree, including Failed and Ready snapshots. Start without explicit replacement returns that owner rather than creating a competing review. Multiple legacy owners fail closed: the UI shows **Suivi ambigu**, preserves the history and does not offer misleading resume actions. No historical state is silently rewritten.

A new validation after a blocked execution is explicit and confirmed in the UI.
It preserves the previous snapshot through `superseded_by`; it does not reset
that execution's counters. A still-running agent cannot be replaced silently.

## Proof contract

Every result carries execution, step, attempt and input-revision identity. Only
complete JSON or a complete fenced JSON document is accepted. Wrong identities,
missing commits, duplicate identifiers and mandatory-to-optional downgrades
cannot advance the workflow. Missing items remain in state; omitting a defect
cannot resolve it.

Evidence is bound to the actual commit. Code changes invalidate old evidence.
The backend verifies CI for the exact PR head and reads the deployed commit from
`https://{pr}.pr.planexpo/version`. Readiness requires backend-owned `ci-head`
(`backend-ci`) and `preview-version` (`git-ancestry`) evidence, plus a mandatory
proof for every applicable mandatory business criterion in acceptance testing.
The backend-owned `ci-head` criterion is exempt from browser acceptance, not from
its independent CI proof. Agents cannot submit or replace those
reserved system fields. `acceptance_evidence_ids` is recorded by the engine,
not trusted from an agent's result.

PR SHA and deployed SHA need not be equal. The PR head must be an ancestor of
the deployed commit. Missing objects or incomplete history produce **version
non confirmée**, not **preview obsolète**. The existing Jenkins freshness UI also
keeps comparisons with no reliable result unknown.

Ticket title, descriptions and custom fields are fingerprinted before and after stages.
Comments are not part of this fingerprint. Changes to fingerprinted content
invalidate its evidence and require a new validation. PR head and deployed
version are checked around acceptance to reject results from a moving target.
Ready snapshots recheck the local worktree on every read and remote conditions
at most every 30 seconds; failed checks withdraw readiness rather than preserve
an unverified green status.

CI validation requires positive proof on the exact PR head: either the legacy
`Execution du job 'build-and-test'` context or all six contexts published by
Planexpo's unified Jenkins pipeline: `ci/rust-unit`, `ci/elm-unit`,
`ci/runtime-build`, `ci/images`, `ci/cypress`, and `preview/deploy`.
Any explicit failure wins even if the legacy context is absent. Unrelated or
partial green results never validate CI; absent/unknown/skipped required stages
remain unconfirmed, and other pending checks prevent a green verdict.
The six-context contract was verified in `Spottt/planexpo-deploy`,
`compose/jenkins/unified-build-test-deploy.groovy` at
`b64e27aa4cb042d6bbb6d25236dd92972b1df2c9` (stage map and finalization list).
Docs-only publishes all six successful exemptions; reused validation keeps
`preview/deploy` pending until deployment. The proof remains Planexpo-specific,
not a guess from any green check.

## Recovery after a partial correction

A completed Correction attempt reporting `failed` now stays in the same execution
and schedules a targeted diagnostic/correction attempt automatically. Existing
local edits, stable defects, proofs and the last failed-test message are retained.
No defect or successful proof is fabricated from prose. The next agent must
diagnose the failing test, record a stable concrete defect with real evidence,
and return `correction_required` while a test is still red. Missing access or a
business decision remains `blocked`, not an automatic retry.

Every completed correction (`passed`, `correction_required`, or `failed`)
consumes one attempt. An unsuccessful attempt counts toward the existing
no-progress guard; limits remain three attempts or two without verified progress.
Failed corrections never reach review/Git sync or trigger staging, commit or
push. Only a successful correction proceeds through independent review, exact
HEAD CI, preview ancestry and acceptance before any Ready state.

The offline lab's `failed-correction-recovery` scenario replays the observed
pattern: a resolved ligature defect plus a new red AI-visibility test, followed
by targeted repair and the full review/CI/preview/acceptance path, without
replacing the execution. Legacy already-failed snapshots are not rewritten or
silently restarted by this change. A dirty legacy tree without a recorded ownership
fingerprint remains manual: the coordinator does not guess which edits belong to it.

The UI preserves the last failure, localizes legacy budget stops, and removes
futile Resume actions for explicit exhausted-budget blockers. Historical
execution counters and the activity journal are retained; starting a new
validation still requires an explicit confirmation and is not the normal
recovery path.

## Persistence and recovery

Snapshots live in `<app_data>/ai_pipeline/validations/<uuid>/state.json`, not in
repository `.ai/` or tracked reports. Unix directories/files use 0700/0600;
writes use a temporary sibling, fsync and atomic rename. Corrupt snapshots
surface errors instead of silently disappearing.

Persist intentions before commit/push, reconcile actual Git state after an
interruption, and never force-push. Active agent sessions are remembered;
resume inspects terminal run state before consuming results and must not send a
second prompt to an active run. The worktree must initially be clean, and its
project, linked ticket, PR and assignments are checked server-side.

Shared native/headless runtime initialization now restores canonical, unpaused
Pending/Running/Waiting validations after recovering chat runs. A still-managed
agent is observed, not duplicated; polling is bounded by its persisted start time.
Blocked, Failed, Ready, superseded and paused snapshots are never restarted by this
hook. Explicit resume is reserved for an actual intervention, not each normal step.

Run consumption checks the exact session/worktree, unique run, original prompt
identity, terminal successful status and linked assistant message ID. Appending a
manual prompt to a technical session does not supply a new orchestration proof.
Reads use the run-log loader, not a session getter that may drain queued messages.
The final result save uses the expected attempt as a compare-and-swap guard; a
late worker cannot replace a newer attempt or undo supersession. A concurrent
pause wins while the completed result is still recorded.

Malformed terminal JSON receives one persisted **format-only** repair, sourced
from the exact prior terminal message. It does not rerun code, reset correction
budgets, relax identity checks or accept reserved backend evidence. The repair
instruction forbids tools but is not a technical sandbox. A second malformed
output stops with a readable diagnostic.

Partial implementation/correction trees carry an exact private fingerprint over
working content, index and untracked files (excluding only verified runtime
configuration). The fingerprint and HEAD are checked before another attempt;
additional edits stop safely without reset, stash, staging or deletion. This is
an interruption guard, not proof of authorship when another process writes during
an active agent. Initial work still requires a clean attributable tree.

## Adversarial verification and scope

The 21-scenario UI lab includes the Failed canonical-owner regression, ambiguous
resume through the real command with temporary RuntimeContext/storage, startup
eligibility, unrelated-run rejection, persistent bounded JSON repair, and a real
local Git refusal preserving a dirty tree. Its service results remain simulated;
its green summary is deliberately not an operational approval of the feature.

Separate command integration tests use temporary RuntimeContext, persisted
metadata/JSONL, and real local Git to exercise result consumption, concurrent
pause, stale-worker compare-and-swap, source-only formatting, dirty-tree guards
and the actual drive loop. External agent/assignment/ticket services in that loop
are explicitly injected test fixtures. This does not certify a live agent,
Jenkins deployment, authenticated browser recipe or production database.

There remains a narrow interruption window between creating an empty technical
session and persisting its execution binding. No prompt is sent before the binding
is durable, so this can leave an empty orphan session, not an untracked agent run.
No automated migration guesses ownership of historical conflicting executions.

## Privacy and practical limits

No automated comments, report attachments, extra ticket status changes, merge,
closure or production writes. A local, editable colleague-facing draft contains
verified functional criteria and remaining checks, not internal orchestration
limitations. Copying it does not publish it.

Preview fixture writes, signatures and mail workflows are authorized for
Planexpo PR previews (mail delivery is not configured). This permission does
not cover production or arbitrary external services.

The backend agent tools are **not technically confined**. The prohibition on
publication/production is an instruction, not an OS/network sandbox. The UI
shows this limit. Keep the worktree reserved while correction is running: the
backend cannot safely attribute simultaneous user edits to a particular agent.
CI, preview and acceptance still require a confirmed PR. Its absence during initial
implementation is expected, not proof of failed CI or a fabricated preview.

## Tests and manual verification

### Offline rehearsal

Open **Pipeline IA → Banc d’essai isolé → Lancer les scénarios**. This action is
available without ClickUp credentials or a selected project. It has no live target
parameters and never starts an AI chat, contacts ClickUp/GitHub/Jenkins/Planexpo,
or pushes a repository. Each run uses disposable state and a local Git fixture.
It cannot replace, pause or resume a real validation.

The lab exercises the actual transition engine, strict result parser, private
storage and local Git ancestry checks. Agent responses and CI/preview evidence
are scripted fixtures, explicitly **not** observations from real services. It
does not exercise the live worker's external adapters or assess AI judgment.
The fifteen scenarios include a review that advances with Unverified CI/recipe
criteria after five resolved defects and three corrections, and a Review waiting
contract-error budget that survives snapshot reload. They assert no false Ready,
no extra correction cycle and no repeated external wait for that contract error.
Every scenario exposes checks and its transition trace; a failing check stays
red. A successful lab report is not a readiness certificate for a real ticket.

The shared `run_ai_pipeline_validation_lab` dispatcher is used by native IPC and
Web Access/mobile. It accepts no target arguments and does not use app-data or
configured credentials. The private temporary directories are cleaned after
each run. Closing the lab does not interact with Jean chat sessions or Run.

Before a real trial, keep the worktree exclusive, use only the confirmed PR preview and
review the privacy/tool-limit notice. The first trial still needs to confirm real
authentication, CI/deployment response formats and functional acceptance behavior.

Targeted automated checks:

```sh
cargo test --manifest-path jean-core/Cargo.toml --lib ai_pipeline::
cargo test --manifest-path jean-core/Cargo.toml --lib validation_lab_dispatch
cargo test --manifest-path jean-core/Cargo.toml --lib jenkins::freshness::tests
bun --bun run test:run src/components/ai-pipeline/AiPipelineTaskList.test.tsx src/components/ai-pipeline/AiPipelineValidationPanel.test.tsx
bun --bun run test:run src/components/ai-pipeline/AiPipelineValidationLab.test.tsx
bun --bun run check:all
```

Before claiming end-to-end production readiness, exercise a real Planexpo PR:
pickup, review/correction, CI and preview, acceptance proofs, pause/resume,
interruption/recovery and manual draft. Verify native, Web Access and mobile
separately. Simulated component tests and headless component screenshots do not
prove the installed native app or its real integrations have been exercised.

Checkout returns a pending worktree before background Git/setup finishes. Validation
waits for its persisted record (250 ms polling, 10 minute limit), outside the
mutation lock. A project mismatch or storage error fails immediately. Timeout
preserves the checkout: retry validation from its worktree, not ticket pickup.
Web Access uses the extended command timeout for this preparation step.

The pickup setup may copy the root project's `jean.json` into the worktree.
With successful setup, validation recognizes only a byte-identical root copy
whose setup starts with the documented copy command. Its SHA-256 and original
HEAD blob are persisted as a private runtime baseline. The file stays untouched
and is excluded from correction staging; baseline changes, staged configuration
or unrelated edits still block. Existing jobs blocked on this setup copy can
adopt the same strict baseline on explicit resume before any agent/effect.

Start feedback is owned by the mutation lifecycle (not mounted row callbacks),
so automatic navigation cannot leave a loading toast behind. Blocked and waiting
results are displayed as such rather than reported as success.

The offline lab includes two unpublished-ticket scenarios: full scripted
implementation/publication/recipe and interrupted PR intention reconciliation.
External effects remain simulated in the lab; separate Git bare and fake-CLI tests
exercise first-push guards and PR readback without contacting real services.
The first real trial must still verify implementation quality, actual PR creation,
assignment, CI/deployment formats and the installed native/Web/mobile transport.

## Worktree presentation

The pickup modal no longer renders execution cards. Each tracked worktree shows
a permanent inline **Automatisation** surface: current step/state, latest activity,
next expected action and direct pause/resume control. None of these essential
items requires opening a menu or expanding a card. Canvas and chat reuse the
same compact presentation and backend-owned query.

In chat the surface is below the title/status toolbar, before session tabs, not
a clickable badge next to CI/preview and ClickUp. There is no validation popover
or overlay. Secondary evidence, full journal, technical sessions, editable draft
and execution history remain optional disclosures; previous executions remain
read-only. Technical sessions open only on explicit request. An empty worktree
stays unchanged unless its existing canvas entry point allows starting validation.
Query errors stay visible with retry and inhibit controls based on stale data.
Zen mode hides the inline chat surface together with the title toolbar. The
shared surface is used in native, Web Access and mobile. Backend proof gates,
correction loops and persisted execution state remain unchanged.

The Projects sidebar shows the same selected execution's **step · state** under
its worktree name. A ready status is not presented as verified when mandatory
current proofs are missing. Sidebar session counts and canvas/manual tabs exclude
attributed technical sessions; their persisted transcripts remain unchanged.

Agent sessions are created without activating the user's chat, and their
`agent_sessions` provenance is saved before sending the prompt. Legacy sessions
are recovered read-only from the first run's exact structured validation prompt
and matching execution/project/worktree/ticket/session/attempt identity, never
from a name alone. Automatically renamed sessions remain recoverable; unprovable
legacy sessions remain visible. Recovery is cached by the first prompt identity
and hash, independently of ongoing streaming; it never opens a chat, drains
queued prompts, or rewrites a running execution.

Agent prompts retain all requirements, defects, proofs and identities, but include
only the last six activity transitions and omit the technical session list.
This reduces repetitive context on long runs without deleting durable history,
changing the proof contract or skipping a review.

The inline surface leads with the current step, latest recorded activity and
next expected action. When stopped by a genuine blocker, its reason replaces
redundant previous activity; the full activity remains in the journal. Long
blockers have a visible summary and explicit full-text disclosure, preserving
space for chat. No linear progress estimate is invented: review/correction may
revisit a step. Execution IDs, budgets and commit hashes remain secondary. An
exhausted correction budget exposes its explicit new-cycle decision directly,
with confirmation, rather than hiding the only available action in details.
History remains read-only. Reduced-motion preferences disable animations and
stale states suppress controls until the query recovers.

### Reactive worktree updates

Successful coordinator persistence broadcasts `cache:invalidate` with
`ai-pipeline-validations`; failed writes do not broadcast an unpersisted state.
The shared MainWindow listener maps that key to the project validation query
prefix (native, Web Access and mobile) and coalesces bursts over 250 ms.
Worktree surfaces observe the same project cache; they do not poll independently
per worktree or invalidate unrelated ClickUp/PR feeds after validation controls.
The 3-second polling fallback remains for missed events and reconnection.
A stale/error response must stay visible as unavailable, not imply fresh proof.

Explicit resume clears only the expired external-wait window. Correction and
no-progress budgets, evidence and execution identity remain unchanged. Restart
recovery does not grant a new timeout or reset those budgets.

Known latency limitation: refreshing an old Ready execution still performs
local Git validation and periodic remote verification before completing the
project-wide list. A slow remote check can therefore delay another worktree's
refresh. Do not reuse an old Ready snapshot as fresh evidence to hide that
latency; transport errors are surfaced as stale/unavailable instead.
