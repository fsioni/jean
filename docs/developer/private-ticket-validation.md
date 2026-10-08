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
- `validation_lab.rs`: targetless offline scenarios using the real engine/parser/store.
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

Recovery is explicit through **Reprendre la validation** after restart or an
intervention. Do not represent this as an automatic startup recovery service.

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
The fourteen scenarios include a review that advances with Unverified CI/recipe
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

The pickup modal no longer renders execution cards. Each worktree presents one
compact **Activité IA** row: the current step, status, and correction count.
Expanding it exposes the latest execution (active first, otherwise most recent),
a chronological transition journal, pause/resume, evidence and manual draft
actions. Earlier executions stay under a collapsed history; they are neither
deleted nor rendered as competing current cards. Technical agent sessions can
be opened explicitly from this worktree activity without automatically populating
the normal chat tabs. These are presentation changes only: persisted execution
state, safety gates, proof verification and correction loops remain backend-owned.
The shared canvas presentation is available in native, Web Access and mobile.

The worktree chat header also exposes a clickable **IA · step · state** badge,
next to CI/preview and ClickUp. Its responsive popover reuses `ValidationCard`
for the blocker, journal, proofs, pause/resume and collapsed execution history,
without navigating away from chat. It shares the modal's existing polling query
(no second polling subscription), scopes selection to the current worktree, and
opens technical sessions only on explicit request. Escape closes the popover,
not the chat. This shared header is rendered in native, Web Access and mobile;
zen mode deliberately hides the entire header. Worktrees without a validation
remain unchanged. A query error offers retry rather than silently hiding access.

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
