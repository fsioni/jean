# Private ticket validation

The AI Pipeline offers two pickup actions: **Récupérer** keeps the existing
worktree/assignment workflow; **Récupérer et valider** starts a private validation
only after the pickup succeeds. Existing worktrees can start validation from the
Pipeline modal. Finishing/merging remains a separate manual action.

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
- `preview_version.rs`: bounded `/version` reads and Git ancestry verification.

Commands are dispatched through `jean-core/src/http_server/dispatch.rs`; native
IPC uses `dispatch_core_command`, so the same implementation serves native,
Web Access and mobile. Do not add a frontend-owned workflow loop.

## Workflow

Review → optional correction/tests → independent review → Git sync → CI →
preview version → acceptance testing → ready for the user's decision.

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
correction. External waits have a persisted start time and a 30-minute ceiling.

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

CI validation requires the exact Planexpo context `Execution du job 'build-and-test'`
on the PR head. An unrelated green check alone is not a successful pipeline.
Absent/unknown/skipped required context stays unconfirmed; other reported failures
or pending checks also prevent a green verdict. This validation is intentionally
Planexpo-specific: a renamed Jenkins context must be explicitly supported before
it can produce a ready validation, rather than guessed from any green check.

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
The feature currently requires an existing PR; a pickup without a PR is blocked
with an explicit reason rather than manufacturing a preview or CI result.

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
Every scenario exposes checks and its transition trace; a failing check stays
red. A successful lab report is not a readiness certificate for a real ticket.

The shared `run_ai_pipeline_validation_lab` dispatcher is used by native IPC and
Web Access/mobile. It accepts no target arguments and does not use app-data or
configured credentials. The private temporary directories are cleaned after
each run. Closing the lab does not interact with Jean chat sessions or Run.

Before a real trial, keep the worktree exclusive, use an existing PR preview and
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
