//! Durable private validation jobs. Every external action starts from persisted intent.
use super::{
    validation_engine as engine, validation_orchestration as orchestration,
    validation_steps as steps, validation_storage::ValidationStore, validation_types::*,
};
use crate::http_server::EmitExt;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

#[cfg(test)]
struct CommandDriveFixture {
    reattached: Mutex<Vec<String>>,
    observed: Mutex<Vec<ValidationExecution>>,
    agents: Mutex<std::collections::VecDeque<(ValidationStep, StepOutcome, Option<String>)>>,
}
fn has_drive_fixture(app: &AppHandle) -> bool {
    #[cfg(test)]
    {
        return app.try_state::<CommandDriveFixture>().is_some();
    }
    #[cfg(not(test))]
    {
        let _ = app;
        false
    }
}

static JOBS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();
fn store(app: &AppHandle) -> Result<ValidationStore, String> {
    Ok(ValidationStore::new(
        app.path().app_data_dir().map_err(|e| e.to_string())?,
    ))
}
fn get(app: &AppHandle, id: &str) -> Result<ValidationExecution, String> {
    store(app)?
        .get(id)?
        .ok_or_else(|| "Validation introuvable".into())
}
fn save(app: &AppHandle, execution: &ValidationExecution) -> Result<(), String> {
    store(app)?.save(execution)?;
    let _ = app.emit_all(
        "cache:invalidate",
        &serde_json::json!({"keys": ["ai-pipeline-validations"]}),
    );
    Ok(())
}

// Persist worker snapshots under the same lock as user actions. User pause and
// its journal entry win even when requested during an awaited agent call.
fn save_worker(app: &AppHandle, execution: &mut ValidationExecution) -> Result<(), String> {
    save_worker_checked(app, execution, None)
}
fn save_worker_checked(
    app: &AppHandle,
    execution: &mut ValidationExecution,
    expected_attempt: Option<&StepIdentity>,
) -> Result<(), String> {
    let _guard = MUTATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(latest) = store(app)?.get(&execution.id)? {
        orchestration::assert_worker_current(execution, &latest)?;
        if expected_attempt.is_some() && latest.active_attempt.as_ref() != expected_attempt {
            return Err(
                "Tentative modifiée pendant consommation ; snapshot obsolète refusé".into(),
            );
        }
        execution.paused = latest.paused;
        for transition in latest.transitions {
            if !execution
                .transitions
                .iter()
                .any(|t| t.timestamp == transition.timestamp && t.message == transition.message)
            {
                execution.transitions.push(transition);
            }
        }
        execution
            .transitions
            .sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        for (index, transition) in execution.transitions.iter_mut().enumerate() {
            transition.revision = index as u64 + 1;
        }
        execution.revision = execution
            .revision
            .max(latest.revision)
            .max(execution.transitions.len() as u64);
    }
    save(app, execution)
}

pub async fn list_ai_pipeline_validations(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<ValidationExecution>, String> {
    let snapshots = store(&app)?.list()?;
    let mut results = Vec::new();
    for execution in snapshots.into_iter().filter(|e| e.project_id == project_id) {
        let execution = refresh_ready_snapshot(&app, execution).await?;
        results.push(enrich_agent_session_provenance(&app, execution).await?);
    }
    Ok(results)
}
pub async fn get_ai_pipeline_validation(
    app: AppHandle,
    execution_id: String,
) -> Result<ValidationExecution, String> {
    let execution = refresh_ready_snapshot(&app, get(&app, &execution_id)?).await?;
    enrich_agent_session_provenance(&app, execution).await
}

// Presentation-only recovery of historical sessions. Never opens a session or
// rewrites a coordinator snapshot. Cache is bound to the immutable first prompt;
// transient read failures are not cached.
type HistoricalSessionCache = HashMap<String, Option<ValidationAgentSession>>;
static HISTORICAL_SESSION_CACHE: OnceLock<Mutex<HistoricalSessionCache>> = OnceLock::new();

fn historical_session_provenance(
    execution: &ValidationExecution,
    session_id: &str,
    _name: &str,
    prompt: &str,
) -> Option<ValidationAgentSession> {
    if !prompt.starts_with("Validation privée Jean, contrat v1.\n") {
        return None;
    }
    let (_, input) = prompt.split_once("\nÉtat d'entrée :\n")?;
    let input: serde_json::Value = serde_json::Deserializer::from_str(input)
        .into_iter::<serde_json::Value>()
        .next()?
        .ok()?;
    for (field, expected) in [
        ("id", execution.id.as_str()),
        ("project_id", execution.project_id.as_str()),
        ("worktree_id", execution.worktree_id.as_str()),
        ("repository_path", execution.repository_path.as_str()),
        ("task_id", execution.task_id.as_str()),
    ] {
        if input.get(field)?.as_str()? != expected {
            return None;
        }
    }
    let (_, sample) = prompt.rsplit_once("L'identité doit être exactement celle-ci :\n")?;
    let sample = serde_json::Deserializer::from_str(sample)
        .into_iter::<serde_json::Value>()
        .next()?
        .ok()?;
    let identity: StepIdentity = serde_json::from_value(sample.get("identity")?.clone()).ok()?;
    if identity.execution_id != execution.id
        || identity.attempt_id.is_empty()
        || input.get("active_session_id")?.as_str()? != session_id
        || input.get("active_attempt")? != &serde_json::to_value(&identity).ok()?
        || input.get("step")? != &serde_json::to_value(identity.step).ok()?
        || !matches!(
            identity.step,
            ValidationStep::Implementation
                | ValidationStep::Review
                | ValidationStep::Correction
                | ValidationStep::Ci
                | ValidationStep::Acceptance
        )
    {
        return None;
    }
    Some(ValidationAgentSession {
        session_id: session_id.into(),
        step: identity.step,
        attempt_id: identity.attempt_id,
    })
}

fn read_historical_session_index(
    path: &std::path::Path,
) -> Option<crate::chat::types::WorktreeIndex> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

async fn enrich_agent_session_provenance(
    app: &AppHandle,
    mut execution: ValidationExecution,
) -> Result<ValidationExecution, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        let Ok(app_data) = app.path().app_data_dir() else {
            return execution;
        };
        // Storage path helpers create directories; migration must remain read-only.
        let safe_id = crate::chat::storage::sanitize_filename(&execution.worktree_id);
        let index_path = app_data
            .join("sessions/index")
            .join(format!("{safe_id}.json"));
        let Some(index) = read_historical_session_index(&index_path) else {
            return execution;
        };
        if index.worktree_id != execution.worktree_id {
            return execution;
        }
        for session in index.sessions {
            if execution
                .agent_sessions
                .iter()
                .any(|known| known.session_id == session.id)
            {
                continue;
            }
            let mut components = std::path::Path::new(&session.id).components();
            if !matches!(components.next(), Some(std::path::Component::Normal(_)))
                || components.next().is_some()
            {
                continue;
            }
            let metadata_path = app_data
                .join("sessions/data")
                .join(&session.id)
                .join("metadata.json");
            let Ok(bytes) = std::fs::read(metadata_path) else {
                continue;
            };
            let Ok(metadata) =
                serde_json::from_slice::<crate::chat::types::SessionMetadata>(&bytes)
            else {
                continue;
            };
            if metadata.id != session.id || metadata.worktree_id != execution.worktree_id {
                continue;
            }
            let Some(first_run) = metadata.runs.first() else {
                continue;
            };
            let key = format!(
                "{}:{}:{}:{:x}",
                execution.id,
                session.id,
                first_run.user_message_id,
                Sha256::digest(first_run.user_message.as_bytes())
            );
            let cache = HISTORICAL_SESSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
            let cached = cache
                .lock()
                .ok()
                .and_then(|entries| entries.get(&key).cloned());
            let provenance = match cached {
                Some(value) => value,
                None => {
                    let value = historical_session_provenance(
                        &execution,
                        &session.id,
                        &session.name,
                        &first_run.user_message,
                    );
                    if let Ok(mut entries) = cache.lock() {
                        // Bound presentation cache independently of the number of past polls.
                        if entries.len() >= 2048 {
                            entries.clear();
                        }
                        entries.insert(key, value.clone());
                    }
                    value
                }
            };
            if let Some(provenance) = provenance {
                execution.agent_sessions.push(provenance);
            }
        }
        execution
    })
    .await
    .map_err(|error| error.to_string())
}

/// Finished proofs are snapshots, not perpetual guarantees. Local changes are
/// detected every read; remote checks are throttled to avoid polling every PR
/// on every UI refresh. Any uncertain remote state removes the ready label.
async fn refresh_ready_snapshot(
    app: &AppHandle,
    mut execution: ValidationExecution,
) -> Result<ValidationExecution, String> {
    if execution.status != ValidationStatus::Ready || execution.superseded_by.is_some() {
        return Ok(execution);
    }
    let observed_revision = execution.revision;
    let path = execution.repository_path.clone();
    let baseline = execution.runtime_config_baseline.clone();
    let local = tauri::async_runtime::spawn_blocking(move || -> Result<(String, bool), String> {
        Ok((
            steps::git(&path, &["rev-parse", "HEAD"])?,
            super::runtime_config::is_clean(&path, baseline.as_ref())?,
        ))
    })
    .await
    .map_err(|e| e.to_string())?;
    let local_valid = local
        .as_ref()
        .is_ok_and(|(head, clean)| *clean && execution.head_commit.as_ref() == Some(head));
    let recent_remote_check = execution
        .last_ready_check
        .as_ref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|checked| {
            (0..30).contains(
                &chrono::Utc::now()
                    .signed_duration_since(checked)
                    .num_seconds(),
            )
        });
    if local_valid && engine::is_ready(&execution) && recent_remote_check {
        return Ok(execution);
    }
    let verification: Result<(), String> = async {
        if !local_valid { return Err("Le worktree a changé depuis la validation : preuves périmées, nouvelle validation requise".into()); }
        if !engine::is_ready(&execution) { return Err("Preuves obligatoires de validation manquantes ou périmées".into()); }
        let fingerprint = criteria_fingerprint(app, &execution).await?;
        if execution.criteria_fingerprint.as_ref() != Some(&fingerprint) {
            return Err("Le ticket a changé depuis la validation : nouvelle validation requise".into());
        }
        let check = remote_check(app, &execution).await?;
        if check.head_sha != execution.head_commit || check.verdict.as_deref() != Some("SUCCESS") {
            return Err("Head PR ou CI changé/non confirmé : validation à renouveler".into());
        }
        let deployed = super::preview_version::fetch_preview_commit(execution.pr_number.ok_or("PR manquante")?).await?;
        if execution.deployed_commit.as_ref() != Some(&deployed) {
            return Err("La version déployée a changé depuis la recette : preuves à renouveler".into());
        }
        Ok(())
    }.await;
    let _guard = MUTATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    let latest = get(app, &execution.id)?;
    if latest.revision != observed_revision || latest.superseded_by.is_some() {
        return Ok(latest);
    }
    execution.last_ready_check = Some(chrono::Utc::now().to_rfc3339());
    if let Err(reason) = verification {
        execution.evidence.iter_mut().for_each(|e| e.stale = true);
        execution.acceptance_evidence_ids.clear();
        // Re-establish backend CI/version proofs before another acceptance pass.
        // A changed head/ticket still requires a distinct new execution.
        execution.step = ValidationStep::Ci;
        engine::block(&mut execution, reason);
    }
    save(app, &execution)?;
    Ok(execution)
}

pub async fn start_ai_pipeline_validation(
    app: AppHandle,
    project_id: String,
    worktree_id: String,
    task_id: Option<String>,
    pr_number: Option<u32>,
    new_execution: Option<bool>,
) -> Result<ValidationExecution, String> {
    // checkout_pr/create_worktree return a pending record immediately. Their
    // background setup persists the real record later: do not mistake that
    // normal window for a missing worktree, or hold MUTATIONS while waiting.
    super::worktree_readiness::wait_until_ready(
        || {
            let data = crate::projects::storage::load_projects_data(&app)?;
            match data.worktrees.iter().find(|w| w.id == worktree_id) {
                Some(worktree) if worktree.project_id != project_id => {
                    Err("Worktree lié à un autre projet".into())
                }
                Some(worktree) => Ok(Some(worktree.clone())),
                None => Ok(None),
            }
        },
        std::time::Duration::from_secs(600),
        std::time::Duration::from_millis(250),
    )
    .await?;
    let execution = {
        let _guard = MUTATIONS
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|e| e.to_string())?;
        let storage = store(&app)?;
        let snapshots = storage.list()?;
        let previous = orchestration::canonical_execution(&snapshots, &worktree_id)?.cloned();
        if let Some(existing) = &previous {
            if !new_execution.unwrap_or(false) {
                return Ok(existing.clone());
            }
            if JOBS
                .get_or_init(|| Mutex::new(HashSet::new()))
                .lock()
                .map_err(|e| e.to_string())?
                .contains(&existing.id)
                || matches!(
                    existing.status,
                    ValidationStatus::Running
                        | ValidationStatus::Waiting
                        | ValidationStatus::Pending
                )
            {
                return Err("Une validation est encore en cours ; aucune nouvelle exécution concurrente autorisée".into());
            }
            if let Some(session_id) = &existing.active_session_id {
                if crate::chat::registry::is_session_actively_managed(session_id) {
                    return Err("Le run précédent est encore actif".into());
                }
                let metadata = crate::chat::storage::load_metadata(&app, session_id)?
                    .ok_or("Manifest précédent introuvable : réconciliation requise")?;
                if metadata.runs.last().is_some_and(|run| {
                    matches!(
                        run.status,
                        crate::chat::types::RunStatus::Running
                            | crate::chat::types::RunStatus::Resumable
                    ) && !crate::chat::run_log::jsonl_has_result_line(&app, session_id, &run.run_id)
                }) {
                    return Err("Le run précédent n'est pas terminal ; réconcilie-le avant une nouvelle validation".into());
                }
            }
        }
        let data = crate::projects::storage::load_projects_data(&app)?;
        let worktree = data
            .worktrees
            .iter()
            .find(|w| w.id == worktree_id && w.project_id == project_id)
            .ok_or("Worktree introuvable dans ce projet")?;
        if pr_number.is_some() && worktree.pr_number.is_some() && pr_number != worktree.pr_number {
            return Err("Numéro de PR différent de celui du worktree".into());
        }
        let task = task_id
            .filter(|id| !id.trim().is_empty())
            .or_else(|| crate::projects::parse_clickup_task_id_from_branch(&worktree.branch))
            .ok_or("Ticket ClickUp requis pour la validation")?;
        if crate::projects::parse_clickup_task_id_from_branch(&worktree.branch)
            .as_ref()
            .is_some_and(|linked| linked != &task)
        {
            return Err("Ticket différent de celui de la branche du worktree".into());
        }
        let mut execution = ValidationExecution::new(
            project_id,
            worktree_id,
            worktree.path.clone(),
            task,
            pr_number.or(worktree.pr_number),
        );
        execution.original_branch = Some(worktree.branch.clone());
        if execution.pr_number.is_none() {
            let branch = steps::git(
                &execution.repository_path,
                &["symbolic-ref", "--quiet", "--short", "HEAD"],
            )?;
            if worktree.project_id != execution.project_id
                || worktree.path != execution.repository_path
                || worktree.pr_number.is_some()
                || worktree.branch != branch
                || execution
                    .original_branch
                    .as_deref()
                    .is_some_and(|original| original != branch)
            {
                return Err(
                    "Identité du worktree initial modifiée ; nouvelle exécution requise".into(),
                );
            }
            let base = worktree
                .base_branch
                .as_deref()
                .filter(|base| !base.is_empty() && !base.starts_with('-'))
                .ok_or("Branche de base initiale absente")?;
            steps::git(
                &execution.repository_path,
                &["check-ref-format", "--branch", base],
            )?;
            execution.original_branch = Some(branch);
            if execution.runtime_config_baseline.is_none() && worktree.setup_success == Some(true) {
                let project = data
                    .find_project(&execution.project_id)
                    .ok_or("Projet absent")?;
                execution.runtime_config_baseline =
                    super::runtime_config::capture(&execution.repository_path, &project.path)?;
            }
            execution.publication_base_branch = worktree.base_branch.clone();
            execution.publication_remote_identity = Some(
                super::validation_publication::capture_remote_identity(&execution.repository_path)?,
            );
        }
        if worktree.setup_success == Some(true) {
            if let Some(project) = data.find_project(&execution.project_id) {
                execution.runtime_config_baseline =
                    super::runtime_config::capture(&execution.repository_path, &project.path)?;
            }
        }
        execution.limitations.push("Le worktree doit rester réservé à cette validation : Jean ne peut pas distinguer les éditions utilisateur concurrentes de celles de l'agent pendant une correction.".into());
        execution.limitations.push("Les outils des agents ne sont pas techniquement confinés ; les interdictions de publication et production sont des instructions. Aucun merge automatique.".into());
        execution.head_commit = Some(steps::git(
            &execution.repository_path,
            &["rev-parse", "HEAD"],
        )?);
        if !steps::is_clean(&execution)? {
            engine::block(&mut execution, "Modifications préexistantes : attribution ambiguë. Nettoie ou sauvegarde le worktree avant de reprendre.");
        }
        if let Some(mut previous) = previous {
            previous.superseded_by = Some(execution.id.clone());
            engine::record(&mut previous, "Nouvelle exécution demandée explicitement ; compteurs et preuves conservés dans l'historique");
            storage.save(&previous)?;
            if let Err(error) = storage.save(&execution) {
                previous.superseded_by = None;
                let _ = storage.save(&previous);
                return Err(error);
            }
        } else {
            storage.save(&execution)?;
        }
        execution
    };
    if execution.status != ValidationStatus::Blocked {
        launch(app, execution.id.clone());
    }
    Ok(execution)
}

pub async fn pause_ai_pipeline_validation(
    app: AppHandle,
    execution_id: String,
) -> Result<ValidationExecution, String> {
    let _guard = MUTATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    let mut execution = get(&app, &execution_id)?;
    engine::pause(&mut execution);
    save(&app, &execution)?;
    Ok(execution)
}
fn verify_owned_worktree(execution: &ValidationExecution) -> Result<(), String> {
    if !matches!(
        execution.step,
        ValidationStep::Implementation | ValidationStep::Correction
    ) {
        return Ok(());
    }
    if let Some(expected) = execution.owned_worktree_fingerprint.as_deref() {
        let actual = super::runtime_config::working_tree_fingerprint(
            &execution.repository_path,
            execution.runtime_config_baseline.as_ref(),
        )?;
        if actual != expected {
            return Err(
                "Modifications extérieures depuis la tentative propriétaire ; reprise refusée"
                    .into(),
            );
        }
        if execution.head_commit.as_ref()
            != Some(&steps::git(
                &execution.repository_path,
                &["rev-parse", "HEAD"],
            )?)
        {
            return Err("HEAD modifié depuis la tentative propriétaire ; reprise refusée".into());
        }
    } else if !steps::is_clean(execution)? {
        return Err("Worktree modifié sans attribution prouvée à la tentative ; réconciliation explicite requise".into());
    }
    Ok(())
}

fn legacy_missing_pr_blocker(reason: Option<&str>) -> bool {
    reason.is_some_and(|reason| reason == "Une PR existante est requise pour vérifier la CI et la preview."
        || reason == "Ticket récupéré sans PR : l'implémentation et la création d'une PR sont requises avant cette validation de revue/recette.")
}

pub async fn resume_ai_pipeline_validation(
    app: AppHandle,
    execution_id: String,
) -> Result<ValidationExecution, String> {
    let execution = {
        let _guard = MUTATIONS
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|e| e.to_string())?;
        let mut execution = get(&app, &execution_id)?;
        let snapshots = store(&app)?.list()?;
        if orchestration::canonical_execution(&snapshots, &execution.worktree_id)?
            .is_none_or(|owner| owner.id != execution.id)
        {
            return Err("Cette validation n’est pas le propriétaire canonique du worktree".into());
        }
        if execution.superseded_by.is_some() {
            return Err("Cette validation a été remplacée ; consulte la nouvelle exécution".into());
        }
        if execution.status == ValidationStatus::Ready {
            return Ok(execution);
        }
        if execution.step == ValidationStep::Correction
            && (execution.correction_cycles >= 3 || execution.no_progress_cycles >= 2)
        {
            return Err("Limite de correction atteinte ; crée une nouvelle exécution après décision explicite".into());
        }
        if execution.pr_number.is_none()
            && execution.effects.is_empty()
            && execution.active_attempt.is_none()
            && execution.step == ValidationStep::Review
            && execution.correction_cycles == 0
            && legacy_missing_pr_blocker(execution.blocker.as_deref())
        {
            if steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?
                != execution.head_commit.clone().ok_or("HEAD manquant")?
            {
                return Err("HEAD initial changé ; nouvelle exécution requise".into());
            }
            let data = crate::projects::storage::load_projects_data(&app)?;
            let worktree = data
                .find_worktree(&execution.worktree_id)
                .ok_or("Worktree absent")?;
            execution.publication_base_branch = worktree.base_branch.clone();
            execution.publication_remote_identity = Some(
                super::validation_publication::capture_remote_identity(&execution.repository_path)?,
            );
            execution.step = ValidationStep::Implementation;
        }
        if execution.active_attempt.is_none() {
            // Older snapshots may have blocked on the setup's copied jean.json.
            // Adopt only the same strictly proven runtime copy, before any work.
            if execution.runtime_config_baseline.is_none()
                && matches!(
                    execution.step,
                    ValidationStep::Review | ValidationStep::Implementation
                )
                && execution.effects.is_empty()
                && execution.correction_cycles == 0
                && execution
                    .blocker
                    .as_deref()
                    .is_some_and(|reason| reason.starts_with("Modifications préexistantes"))
            {
                let data = crate::projects::storage::load_projects_data(&app)?;
                if data.find_worktree(&execution.worktree_id).is_some_and(|w| {
                    w.project_id == execution.project_id
                        && w.path == execution.repository_path
                        && w.setup_success == Some(true)
                }) {
                    if let Some(project) = data.find_project(&execution.project_id) {
                        execution.runtime_config_baseline = super::runtime_config::capture(
                            &execution.repository_path,
                            &project.path,
                        )?;
                    }
                }
            }
            if execution.step == ValidationStep::Review && !steps::is_clean(&execution)? {
                return Err("Le worktree doit être propre avant reprise de review".into());
            }
            verify_owned_worktree(&execution)?;
            execution.blocker = None;
        }
        steps::verify_runtime_config(&execution)?;
        execution.status = ValidationStatus::Pending;
        execution.paused = false;
        // Explicit retry grants a fresh external wait window; startup recovery
        // keeps the original deadline, and correction budgets are never reset.
        execution.waiting_since = None;
        engine::record(&mut execution, "Reprise demandée");
        save(&app, &execution)?;
        execution
    };
    launch(app, execution.id.clone());
    Ok(execution)
}

/// Called once during application startup; never resumes genuinely blocked jobs.
/// Conflicting historical owners fail closed rather than being selected by date.
pub fn recover_ai_pipeline_validations(app: AppHandle) -> Result<(), String> {
    let snapshots = store(&app)?.list()?;
    for execution in &snapshots {
        if orchestration::recoverable(execution) {
            match orchestration::canonical_execution(&snapshots, &execution.worktree_id) {
                Ok(Some(owner)) if owner.id == execution.id => {
                    launch(app.clone(), execution.id.clone())
                }
                Err(error) => log::warn!("Validation {} recovery refused: {error}", execution.id),
                _ => {}
            }
        }
    }
    Ok(())
}

fn launch(app: AppHandle, id: String) {
    let Ok(mut jobs) = JOBS.get_or_init(|| Mutex::new(HashSet::new())).lock() else {
        return;
    };
    if !jobs.insert(id.clone()) {
        return;
    }
    drop(jobs);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = drive(&app, &id).await {
            let _guard = MUTATIONS.get_or_init(|| Mutex::new(())).lock().ok();
            if let Ok(mut execution) = get(&app, &id) {
                if execution.superseded_by.is_none()
                    && !error.contains("snapshot obsolète refusé")
                    && error != "Worker interrompu par pause ou remplacement"
                {
                    // Parsing failed only after successful run/prompt binding. Preserve
                    // this attempt's edits before scheduling a format-only repair.
                    if (error.starts_with("Résultat structuré invalide :")
                        || error == "Résultat JSON incomplet")
                        && matches!(
                            execution.step,
                            ValidationStep::Implementation | ValidationStep::Correction
                        )
                        && execution.active_attempt.is_some()
                        && execution.active_session_id.is_some()
                    {
                        match super::runtime_config::working_tree_fingerprint(
                            &execution.repository_path,
                            execution.runtime_config_baseline.as_ref(),
                        ) {
                            Ok(fingerprint) => {
                                execution.owned_worktree_fingerprint = Some(fingerprint)
                            }
                            Err(fingerprint_error) => {
                                engine::block(&mut execution, format!("Attribution des éditions avant réparation impossible : {fingerprint_error}"));
                                let _ = save(&app, &execution);
                                if let Ok(mut jobs) =
                                    JOBS.get_or_init(|| Mutex::new(HashSet::new())).lock()
                                {
                                    jobs.remove(&id);
                                }
                                return;
                            }
                        }
                    }
                    if !engine::repair_agent_result(&mut execution, &error)
                        && !(execution.status == ValidationStatus::Blocked
                            && execution.agent_result_repair_retries > 0
                            && (error.starts_with("Résultat structuré invalide :")
                                || error == "Résultat JSON incomplet"))
                    {
                        engine::block(&mut execution, error);
                    }
                    let _ = save(&app, &execution);
                }
            }
        }
        if let Ok(mut jobs) = JOBS.get_or_init(|| Mutex::new(HashSet::new())).lock() {
            jobs.remove(&id);
        }
        // A resume can race with the old worker observing pause and exiting.
        if get(&app, &id).is_ok_and(|execution| orchestration::recoverable(&execution)) {
            launch(app, id);
        }
    });
}

fn pending_pr_publication(execution: &ValidationExecution) -> bool {
    execution.step == ValidationStep::CreatePr
        && execution.active_attempt.as_ref().is_some_and(|attempt| {
            attempt.execution_id == execution.id
                && attempt.step == ValidationStep::CreatePr
                && execution.effects.iter().any(|effect| {
                    effect.id == format!("create-pr:{}", attempt.attempt_id)
                        && effect.kind == "create_pr"
                        && !effect.confirmed
                        && Some(&effect.intended_commit) == execution.head_commit.as_ref()
                })
        })
}

/// An integrated remote commit is never a publication result: restart review.
async fn integrate_remote_before_publication(
    app: &AppHandle,
    execution: &mut ValidationExecution,
    identity: &StepIdentity,
) -> Result<bool, String> {
    use super::validation_publication as publication;
    // A truly unpublished feature has no remote branch. Preparation proves its
    // absence; a feature already pushed before PR creation still needs integration.
    let plan = if let Some(plan) = execution.pending_git_integration.clone() {
        plan
    } else {
        let snapshot = execution.clone();
        let plan =
            tokio::task::spawn_blocking(move || publication::prepare_remote_integration(&snapshot))
                .await
                .map_err(|error| error.to_string())??;
        let Some(plan) = plan else {
            return Ok(false);
        };
        if execution.remote_integration_attempts >= 3 {
            return Err("La branche distante change de façon répétée : 3 intégrations maximum, aucun push forcé".into());
        }
        execution.remote_integration_attempts += 1;
        // Legacy PR executions did not capture origin. Bind the authorized target
        // at this durable intent so subsequent rounds cannot silently adopt another.
        execution
            .publication_remote_identity
            .get_or_insert_with(|| plan.remote_identity.clone());
        execution.pending_git_integration = Some(plan.clone());
        engine::record(
            execution,
            "Mise à jour distante détectée : préparation d’une fusion locale, sans publication",
        );
        save_worker_checked(app, execution, Some(identity))?;
        plan
    };
    let current = get(app, &execution.id)?;
    orchestration::assert_worker_current(execution, &current)?;
    if current.active_attempt.as_ref() != Some(identity)
        || current.pending_git_integration.as_ref() != Some(&plan)
        || current.head_commit != execution.head_commit
    {
        return Err(
            "Tentative ou intention modifiée avant intégration Git ; action refusée".into(),
        );
    }
    if current.paused {
        return Ok(true);
    }
    let snapshot = execution.clone();
    let merge_plan = plan.clone();
    // A pause during an in-flight Git operation does not cancel that operation;
    // its result is persisted, but no review/push starts while paused. No lock over network.
    let merged = tokio::task::spawn_blocking(move || {
        let head = steps::git(&snapshot.repository_path, &["rev-parse", "HEAD"])?;
        if head == merge_plan.local_head {
            publication::execute_remote_integration(&snapshot, &merge_plan)
        } else {
            publication::verify_completed_integration(&snapshot, &merge_plan)
        }
    })
    .await
    .map_err(|error| error.to_string())?;
    let head = match merged {
        Ok(head) => head,
        Err(error)
            if error == "La branche distante a changé depuis la préparation"
                || error == "Le plan de fusion a changé"
                || error == "Intégration devenue inutile ; plan refusé" =>
        {
            // These errors precede merge. Replace stale intent only with untouched local HEAD/tree.
            if steps::git(&execution.repository_path, &["rev-parse", "HEAD"])? != plan.local_head
                || !steps::is_clean(execution)?
            {
                return Err(error);
            }
            execution.pending_git_integration = None;
            engine::record(execution, "La branche distante a encore avancé ; nouvelle préparation bornée avant publication");
            save_worker_checked(app, execution, Some(identity))?;
            return Ok(true);
        }
        Err(error) => return Err(error),
    };
    execution.head_commit = Some(head);
    execution.pending_git_integration = None;
    execution
        .evidence
        .iter_mut()
        .for_each(|proof| proof.stale = true);
    execution.requirements.iter_mut().for_each(|requirement| {
        requirement.status = RequirementStatus::Unverified;
        requirement.evidence_ids.clear();
        requirement.justification = None;
    });
    execution.defects.iter_mut().for_each(|defect| {
        defect.resolved = false;
        defect.evidence_ids.clear();
    });
    execution.acceptance_evidence_ids.clear();
    execution.deployed_commit = None;
    execution.last_ready_check = None;
    execution.owned_worktree_fingerprint = None;
    execution.active_attempt = None;
    execution.active_session_id = None;
    execution.agent_result_repair_retries = 0;
    execution.agent_result_repair_source_session = None;
    execution.review_wait_retries = 0;
    execution.waiting_since = None;
    // An unconfirmed intent for the old HEAD is obsolete after integration.
    // This does not claim it was never published; the new HEAD needs new review.
    execution.effects.retain(|effect| {
        !(effect.kind == "push" && !effect.confirmed && effect.intended_commit == plan.local_head)
    });
    execution.effects.push(ExternalEffect {
        id: format!("git-integration:{}", identity.attempt_id),
        kind: "git_integration".into(),
        intended_commit: execution
            .head_commit
            .clone()
            .ok_or("HEAD intégré manquant")?,
        confirmed: true,
    });
    execution.step = ValidationStep::Review;
    execution.status = ValidationStatus::Pending;
    execution.blocker = None;
    engine::record(execution, "Branche distante intégrée localement sans conflit ; anciennes intentions de push remplacées, preuves invalidées et nouvelle revue obligatoire avant publication");
    save_worker_checked(app, execution, Some(identity))?;
    Ok(true)
}

fn retry_remote_divergence(error: &str, retries: &mut u8) -> bool {
    if error != "La branche feature distante a divergé ; intégration puis nouvelle review requises"
        || *retries >= 2
    {
        return false;
    }
    *retries += 1;
    true
}

async fn drive(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut waits = 0;
    let mut git_sync_races = 0;
    loop {
        let mut execution = get(app, id)?;
        if execution.superseded_by.is_some()
            || execution.paused
            || matches!(
                execution.status,
                ValidationStatus::Ready | ValidationStatus::Failed | ValidationStatus::Blocked
            )
        {
            return Ok(());
        }
        if let Some(session_id) = execution.active_session_id.as_deref() {
            if crate::chat::registry::is_session_actively_managed(session_id) {
                let metadata = crate::chat::storage::load_metadata(app, session_id)?
                    .ok_or("Run actif sans manifest ; réconciliation requise")?;
                if session_requires_manual_reconciliation(&metadata) {
                    return Err("Run en attente de décision ou permission utilisateur ; reprise explicite nécessaire".into());
                }
                let run = metadata.runs.last().ok_or("Run actif absent du manifest")?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|error| error.to_string())?
                    .as_secs();
                if now.saturating_sub(run.started_at) >= 3600 {
                    return Err("Run agent toujours actif après une heure ; aucun second prompt envoyé. Reprise explicite après sa fin.".into());
                }
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                continue;
            }
        }
        let snapshots = store(app)?.list()?;
        if orchestration::canonical_execution(&snapshots, &execution.worktree_id)?
            .is_none_or(|owner| owner.id != execution.id)
        {
            return Err("Validation non canonique ; aucune action autorisée".into());
        }
        let data = crate::projects::storage::load_projects_data(app)?;
        steps::verify_runtime_config(&execution)?;
        let worktree = data
            .worktrees
            .iter()
            .find(|w| w.id == execution.worktree_id && w.project_id == execution.project_id)
            .ok_or("Worktree absent ou changé de projet")?;
        if execution.publication_base_branch.is_some()
            && (execution.pr_number.is_none() || execution.step == ValidationStep::CreatePr)
            && worktree.base_branch != execution.publication_base_branch
        {
            return Err("Branche de base initiale modifiée : publication refusée".into());
        }
        if worktree.path != execution.repository_path
            || (worktree
                .pr_number
                .is_some_and(|pr| Some(pr) != execution.pr_number)
                && !(pending_pr_publication(&execution)))
        {
            return Err("Périmètre worktree/PR différent de celui de l'exécution".into());
        }
        let current_branch = steps::git(
            &execution.repository_path,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        )?;
        if current_branch != worktree.branch
            || execution
                .original_branch
                .as_deref()
                .is_some_and(|original| original != current_branch)
        {
            return Err("La branche du worktree a changé ; validation et push refusés".into());
        }
        if execution.original_branch.is_none() {
            execution.original_branch = Some(worktree.branch.clone());
            save_worker(app, &mut execution)?;
        }
        if let Some(pr) = execution
            .pr_number
            .filter(|_| !(pending_pr_publication(&execution)))
        {
            if !has_drive_fixture(app) {
                super::commands::verify_ai_pipeline_github_assignment(
                    app.clone(),
                    execution.project_id.clone(),
                    pr,
                )
                .await?;
            }
        } else if matches!(
            execution.step,
            ValidationStep::Ci
                | ValidationStep::Preview
                | ValidationStep::Acceptance
                | ValidationStep::Complete
        ) {
            return Err("PR requise pour CI/preview/recette".into());
        }
        if execution.pr_number.is_some()
            && execution.step == ValidationStep::Review
            && execution.correction_cycles == 0
            && execution.effects.is_empty()
        {
            assert_remote_head(app, &execution).await?;
        }
        let fingerprint = criteria_fingerprint(app, &execution).await?;
        if execution
            .criteria_fingerprint
            .as_ref()
            .is_some_and(|old| old != &fingerprint)
        {
            execution.evidence.iter_mut().for_each(|e| e.stale = true);
            execution
                .requirements
                .iter_mut()
                .for_each(|r| r.status = RequirementStatus::Unverified);
            save_worker(app, &mut execution)?;
            return Err(
                "Le contenu ou les critères du ticket ont changé : nouvelle validation requise"
                    .into(),
            );
        }
        if execution.criteria_fingerprint.is_none() {
            execution.criteria_fingerprint = Some(fingerprint);
            save_worker(app, &mut execution)?;
        }
        let identity = if let Some(identity) = execution.active_attempt.clone() {
            identity
        } else {
            verify_owned_worktree(&execution)?;
            let identity = engine::begin_attempt(&mut execution)?;
            save_worker(app, &mut execution)?;
            identity
        };
        if execution.paused {
            return Ok(());
        }
        let mut result = if execution.active_session_id.is_some() {
            reconcile_session(app, &execution, &identity).await?
        } else {
            match execution.step {
                ValidationStep::GitSync => {
                    if execution.pr_number.is_some() {
                        assert_pr_branch(app, &execution).await?;
                    }
                    if integrate_remote_before_publication(app, &mut execution, &identity).await? {
                        continue;
                    }
                    if !steps::is_clean(&execution)? {
                        return Err("Worktree modifié après review : push refusé".into());
                    }
                    let head = steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?;
                    if execution.head_commit.as_ref() != Some(&head) {
                        return Err("HEAD a changé après review".into());
                    }
                    if !execution
                        .effects
                        .iter()
                        .any(|effect| effect.id == identity.attempt_id)
                    {
                        execution.effects.push(ExternalEffect {
                            id: identity.attempt_id.clone(),
                            kind: "push".into(),
                            intended_commit: head.clone(),
                            confirmed: false,
                        });
                    }
                    save_worker(app, &mut execution)?;
                    let path = execution.repository_path.clone();
                    let sync_execution = execution.clone();
                    let publication = tauri::async_runtime::spawn_blocking(move || {
                        steps::sync_git(&sync_execution)
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                    let head = match publication {
                        Ok(head) => head,
                        Err(error) if retry_remote_divergence(&error, &mut git_sync_races) => {
                            // A bot may update the remote between preparation and fetch.
                            // This precise ancestry refusal precedes push; refetch/integrate
                            // on the next loop, never retry an ambiguous push failure.
                            engine::record(&mut execution, "Branche distante mise à jour juste avant publication ; retour à la préparation Git, sans push forcé");
                            save_worker_checked(app, &mut execution, Some(&identity))?;
                            continue;
                        }
                        Err(error) => return Err(error),
                    };
                    if steps::git(&path, &["rev-parse", "HEAD"])? != head {
                        return Err("HEAD a changé pendant le push".into());
                    }
                    execution
                        .effects
                        .iter_mut()
                        .filter(|e| e.kind == "push" && e.intended_commit == head)
                        .for_each(|e| e.confirmed = true);
                    save_worker(app, &mut execution)?;
                    basic_result(identity.clone(), head)
                }
                ValidationStep::CreatePr => {
                    create_pr_result(app, &mut execution, &identity).await?
                }
                ValidationStep::Ci => ci_result(app, &mut execution, &identity).await?,
                ValidationStep::Preview => preview_result(&execution, identity.clone()).await?,
                ValidationStep::Complete => return Ok(()),
                _ => execute_agent(app, &mut execution, &identity).await?,
            }
        };
        steps::verify_runtime_config(&execution)?;
        if execution.step == ValidationStep::Ci && execution.active_session_id.is_some() {
            let check = remote_check(app, &execution).await?;
            if check.head_sha != execution.head_commit {
                return Err("Head PR changé pendant diagnostic CI".into());
            }
            match check.verdict.as_deref() {
                Some("FAILURE") => {
                    result.outcome = StepOutcome::CorrectionRequired;
                    if result.defects.is_empty() {
                        result.defects.push(Defect {
                            id: "ci-failure".into(),
                            description: "CI rouge sur le head testé".into(),
                            mandatory: true,
                            resolved: false,
                            evidence_ids: vec![],
                        });
                    }
                }
                Some("SUCCESS") => {
                    result = basic_result(
                        identity.clone(),
                        execution.head_commit.clone().ok_or("Head manquant")?,
                    );
                    add_ci_proof(&mut result, execution.pr_number.unwrap_or_default());
                }
                _ => {
                    result.outcome = StepOutcome::Waiting;
                    result.message = Some("CI en cours ou état non confirmé".into());
                }
            }
        }
        if matches!(
            execution.step,
            ValidationStep::Correction | ValidationStep::Implementation
        ) && result.outcome == StepOutcome::Passed
        {
            let commit_subject = if execution.step == ValidationStep::Implementation {
                "feat: implement ticket"
            } else {
                "fix: address review findings"
            };
            let actual_head = steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?;
            if execution.head_commit.as_ref() != Some(&actual_head) {
                let parent = steps::git(&execution.repository_path, &["rev-parse", "HEAD^"])?;
                let subject =
                    steps::git(&execution.repository_path, &["log", "-1", "--format=%s"])?;
                let intended = execution.effects.iter().any(|effect| {
                    effect.id == format!("commit:{}", identity.attempt_id)
                        && effect.kind == "commit"
                        && effect.intended_commit == parent
                });
                if !intended || subject != commit_subject || !steps::is_clean(&execution)? {
                    return Err("HEAD a changé sans commit de correction réconciliable ; intervention requise".into());
                }
            }
            // Commit the corrected tree before the next independent review. Do not
            // relabel the agent's old test evidence as proof of the new revision.
            if !steps::is_clean(&execution)? {
                let head_before = steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?;
                if execution.head_commit.as_ref() != Some(&head_before) {
                    return Err("HEAD changé pendant correction ; commit refusé".into());
                }
                let effect_id = format!("commit:{}", identity.attempt_id);
                if execution
                    .effects
                    .iter()
                    .any(|effect| effect.id == effect_id && effect.intended_commit != head_before)
                {
                    return Err("Intention de commit différente du HEAD initial".into());
                }
                if !execution.effects.iter().any(|e| e.id == effect_id) {
                    execution.effects.push(ExternalEffect {
                        id: effect_id,
                        kind: "commit".into(),
                        intended_commit: head_before,
                        confirmed: false,
                    });
                }
                save_worker(app, &mut execution)?;
                super::runtime_config::stage_correction(
                    &execution.repository_path,
                    execution.runtime_config_baseline.as_ref(),
                )?;
                steps::git(
                    &execution.repository_path,
                    &["commit", "-m", commit_subject],
                )?;
            }
            result.commit = steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?;
            execution.owned_worktree_fingerprint = None;
            execution
                .effects
                .iter_mut()
                .filter(|e| e.kind == "commit" && e.id == format!("commit:{}", identity.attempt_id))
                .for_each(|e| e.confirmed = true);
            save_worker(app, &mut execution)?;
            result.evidence.clear();
            result.defects.iter_mut().for_each(|d| {
                d.resolved = false;
                d.evidence_ids.clear();
            });
            result.requirements.iter_mut().for_each(|r| {
                r.status = RequirementStatus::Unverified;
                r.evidence_ids.clear();
            });
        } else if steps::git(&execution.repository_path, &["rev-parse", "HEAD"])? != result.commit {
            return Err("Le commit déclaré par l'agent ne correspond pas au HEAD réel".into());
        }
        if execution.step == ValidationStep::Acceptance {
            assert_remote_head(app, &execution).await?;
            let version = preview_result(&execution, identity.clone()).await?;
            assert_acceptance_version(&execution, &version)?;
        }
        if execution.criteria_fingerprint.as_ref()
            != Some(&criteria_fingerprint(app, &execution).await?)
        {
            execution.evidence.iter_mut().for_each(|e| e.stale = true);
            save_worker(app, &mut execution)?;
            return Err("Le ticket a changé pendant l'étape ; résultat rejeté".into());
        }
        if matches!(
            execution.step,
            ValidationStep::Implementation | ValidationStep::Correction
        ) && result.outcome != StepOutcome::Passed
        {
            execution.owned_worktree_fingerprint =
                Some(super::runtime_config::working_tree_fingerprint(
                    &execution.repository_path,
                    execution.runtime_config_baseline.as_ref(),
                )?);
            save_worker(app, &mut execution)?;
        }
        // Pause may have been requested while send_chat_message was awaited.
        execution.paused = get(app, id)?.paused;
        let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let snapshot = execution.clone();
        let result = tauri::async_runtime::spawn_blocking(move || -> Result<StepResult, String> {
            super::validation_artifacts::persist_artifacts(&app_data, &snapshot, &mut result)?;
            Ok(result)
        })
        .await
        .map_err(|e| e.to_string())??;
        engine::apply_result(&mut execution, result)?;
        save_worker_checked(app, &mut execution, Some(&identity))?;
        if execution.status == ValidationStatus::Waiting {
            waits += 1;
            let elapsed = execution
                .waiting_since
                .as_deref()
                .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
                .map(|time| chrono::Utc::now().signed_duration_since(time).num_seconds())
                .unwrap_or(0);
            if waits >= 30 || elapsed >= 1800 {
                engine::block(
                    &mut execution,
                    "Attente externe dépassée (30 minutes) ; reprise explicite disponible",
                );
                save_worker(app, &mut execution)?;
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        } else {
            waits = 0;
        }
    }
}

fn assert_acceptance_version(
    execution: &ValidationExecution,
    version: &StepResult,
) -> Result<(), String> {
    if version.outcome != StepOutcome::Passed
        || version
            .deployed_commit
            .as_deref()
            .is_none_or(|sha| sha.trim().is_empty())
        || version.deployed_commit != execution.deployed_commit
    {
        return Err("La preview a changé pendant la recette : résultat à refaire".into());
    }
    Ok(())
}

fn verify_publication_remote_identity(expected: Option<&str>, actual: &str) -> Result<(), String> {
    if expected != Some(actual) {
        return Err("Identité du dépôt distant absente ou modifiée : publication refusée".into());
    }
    Ok(())
}

async fn create_pr_result(
    app: &AppHandle,
    execution: &mut ValidationExecution,
    identity: &StepIdentity,
) -> Result<StepResult, String> {
    if !steps::is_clean(execution)? {
        return Err("Worktree modifié après review : PR refusée".into());
    }
    let remote_identity =
        super::validation_publication::capture_remote_identity(&execution.repository_path)?;
    verify_publication_remote_identity(
        execution.publication_remote_identity.as_deref(),
        &remote_identity,
    )?;
    let head = steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?;
    if execution.head_commit.as_ref() != Some(&head) {
        return Err("HEAD changé après review : PR refusée".into());
    }
    let branch = execution
        .original_branch
        .clone()
        .ok_or("Branche initiale absente")?;
    let base = execution
        .publication_base_branch
        .clone()
        .ok_or("Branche de base absente : création PR bloquée")?;
    let token = crate::projects::resolve_clickup_token(app, Some(&execution.project_id))?;
    let task = crate::projects::clickup_client::clickup_get(
        &token,
        &format!("/task/{}", execution.task_id),
    )
    .await?;
    let title = task
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Titre ticket absent")?
        .to_owned();
    let effect_id = format!("create-pr:{}", identity.attempt_id);
    if execution
        .effects
        .iter()
        .any(|effect| effect.id == effect_id && effect.intended_commit != head)
    {
        return Err("Intention de création PR différente du HEAD revu".into());
    }
    if !execution
        .effects
        .iter()
        .any(|effect| effect.id == effect_id)
    {
        execution.effects.push(ExternalEffect {
            id: effect_id.clone(),
            kind: "create_pr".into(),
            intended_commit: head.clone(),
            confirmed: false,
        });
        save_worker(app, execution)?;
    }
    let cwd = execution.repository_path.clone();
    let task_id = execution.task_id.clone();
    let gh = crate::gh_cli::config::resolve_gh_binary(app);
    let owned_app = app.clone();
    let intended_head = head.clone();
    let expected_remote = execution.publication_remote_identity.clone();
    let published = tauri::async_runtime::spawn_blocking(move || {
        let actual_remote = super::validation_publication::capture_remote_identity(&cwd)?;
        verify_publication_remote_identity(expected_remote.as_deref(), &actual_remote)?;
        let repository = super::commands::repo_slug_for_path(&cwd)?;
        let login = super::commands::gh_login(&owned_app, &cwd, &repository)?;
        super::validation_publication::publish_pr(
            &cwd,
            &gh,
            &repository,
            &branch,
            &base,
            &intended_head,
            &title,
            &task_id,
            &login,
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::projects::storage::persist_validation_pr(app, execution, &published)?;
    execution.pr_number = Some(published.number);
    save_worker(app, execution)?;
    let assignment_id = format!("assign-pr:{}", identity.attempt_id);
    if !execution
        .effects
        .iter()
        .any(|effect| effect.id == assignment_id)
    {
        execution.effects.push(ExternalEffect {
            id: assignment_id.clone(),
            kind: "assign_pr".into(),
            intended_commit: head.clone(),
            confirmed: false,
        });
        save_worker(app, execution)?;
    }
    let assignment = super::commands::assign_pr_to_me(
        app.clone(),
        execution.project_id.clone(),
        published.number,
    )
    .await?;
    if !assignment.ok {
        return Err("Assignation GitHub de la PR non confirmée ; publication à reprendre".into());
    }
    super::commands::verify_ai_pipeline_github_assignment(
        app.clone(),
        execution.project_id.clone(),
        published.number,
    )
    .await?;
    execution
        .effects
        .iter_mut()
        .filter(|effect| effect.id == assignment_id && effect.intended_commit == head)
        .for_each(|effect| effect.confirmed = true);
    execution
        .effects
        .iter_mut()
        .filter(|effect| effect.id == effect_id && effect.intended_commit == head)
        .for_each(|effect| effect.confirmed = true);
    save_worker(app, execution)?;
    Ok(basic_result(identity.clone(), head))
}

fn basic_result(identity: StepIdentity, commit: String) -> StepResult {
    StepResult {
        identity,
        outcome: StepOutcome::Passed,
        commit,
        requirements: vec![],
        defects: vec![],
        evidence: vec![],
        message: None,
        deployed_commit: None,
    }
}
async fn execute_agent(
    app: &AppHandle,
    execution: &mut ValidationExecution,
    identity: &StepIdentity,
) -> Result<StepResult, String> {
    #[cfg(test)]
    if let Some(fixture) = app.try_state::<CommandDriveFixture>() {
        fixture
            .observed
            .lock()
            .map_err(|error| error.to_string())?
            .push(execution.clone());
        let (step, outcome, edit) = fixture
            .agents
            .lock()
            .map_err(|error| error.to_string())?
            .pop_front()
            .ok_or("Unexpected external agent call in isolated drive fixture")?;
        if step != execution.step {
            return Err("Scripted agent step mismatch".into());
        }
        if let Some(edit) = edit {
            std::fs::write(
                std::path::Path::new(&execution.repository_path).join("owned.txt"),
                edit,
            )
            .map_err(|error| error.to_string())?;
        }
        let mut result = basic_result(
            identity.clone(),
            steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?,
        );
        result.outcome = outcome;
        result.message = Some("isolated scripted agent result".into());
        return Ok(result);
    }
    if execution.step == ValidationStep::Acceptance {
        assert_remote_head(app, execution).await?;
        let version = preview_result(execution, identity.clone()).await?;
        assert_acceptance_version(execution, &version)?;
    }
    let session = crate::chat::create_background_session(
        app.clone(),
        execution.worktree_id.clone(),
        execution.repository_path.clone(),
        Some(format!(
            "Validation privée · {:?} · {}",
            execution.step, identity.attempt_id
        )),
    )
    .await?;
    execution.record_agent_session(session.id.clone(), identity);
    save_worker(app, execution)?;
    send_existing_session(app, execution, identity, session.id).await
}
async fn agent_prompt(
    app: &AppHandle,
    execution: &ValidationExecution,
    identity: &StepIdentity,
    current_session: &str,
) -> Result<String, String> {
    let Some(source_id) = execution.agent_result_repair_source_session.as_deref() else {
        if execution.agent_result_repair_retries > 0 {
            return Err("Réparation sans session source prouvée ; aucun travail rejoué".into());
        }
        return steps::prompt(execution, identity);
    };
    if source_id == current_session {
        return Err("La session de réparation ne peut pas être la source".into());
    }
    let metadata = crate::chat::storage::load_metadata(app, source_id)?
        .ok_or("Session source de réparation introuvable")?;
    if metadata.id != source_id
        || metadata.worktree_id != execution.worktree_id
        || metadata.runs.len() != 1
    {
        return Err("Session source de réparation ambiguë".into());
    }
    let run = &metadata.runs[0];
    let source_identity =
        prompt_step_identity(&run.user_message).ok_or("Prompt source non lié à une tentative")?;
    if source_identity.execution_id != execution.id
        || source_identity.step != execution.step
        || run.cancelled
        || run.status != crate::chat::types::RunStatus::Completed
        || !execution.agent_sessions.iter().any(|session| {
            session.session_id == source_id
                && session.attempt_id == source_identity.attempt_id
                && session.step == source_identity.step
        })
    {
        return Err("Tentative source de réparation non prouvée".into());
    }
    let assistant_id = run
        .assistant_message_id
        .as_deref()
        .ok_or("Message source absent")?;
    let source_messages = crate::chat::run_log::load_session_messages(app, source_id)?;
    let source = source_messages
        .iter()
        .find(|message| {
            message.id == assistant_id
                && message.session_id == source_id
                && matches!(message.role, crate::chat::types::MessageRole::Assistant)
                && !message.cancelled
        })
        .ok_or("Sortie source de réparation introuvable")?;
    if source.content.len() > 200_000 {
        return Err("Sortie source trop volumineuse pour réparation sûre".into());
    }
    steps::format_repair_prompt(execution, identity, &source.content)
}

async fn send_existing_session(
    app: &AppHandle,
    execution: &ValidationExecution,
    identity: &StepIdentity,
    session_id: String,
) -> Result<StepResult, String> {
    let prompt = agent_prompt(app, execution, identity, &session_id).await?;
    let message = crate::chat::send_chat_message(
        app.clone(),
        session_id.clone(),
        execution.worktree_id.clone(),
        execution.repository_path.clone(),
        prompt.clone(),
        None,
        Some("yolo".into()),
        None,
        None,
        None,
        Some("French".into()),
        None,
        None,
        None,
        None,
        None,
        Some(false),
    )
    .await?;
    let metadata = crate::chat::storage::load_metadata(app, &session_id)?
        .ok_or("Manifest agent absent après envoi ; réconciliation requise")?;
    let run = metadata.runs.last().ok_or("Run agent absent après envoi")?;
    orchestration::assert_run_binding(
        execution,
        &session_id,
        (run.user_message == prompt).then_some(identity),
        metadata.runs.len(),
        message.cancelled || run.cancelled,
        run.status == crate::chat::types::RunStatus::Completed,
    )?;
    if message.session_id != session_id
        || run.assistant_message_id.as_deref() != Some(message.id.as_str())
    {
        return Err("Message assistant non lié au run agent ; résultat refusé".into());
    }
    let result = steps::parse_agent_result(&message.content, identity)?;
    reject_reserved_agent_fields(&result)?;
    Ok(result)
}

fn prompt_step_identity(prompt: &str) -> Option<StepIdentity> {
    let (_, sample) = prompt.rsplit_once("L'identité doit être exactement celle-ci :\n")?;
    let sample = serde_json::Deserializer::from_str(sample)
        .into_iter::<serde_json::Value>()
        .next()?
        .ok()?;
    serde_json::from_value(sample.get("identity")?.clone()).ok()
}

fn session_requires_manual_reconciliation(metadata: &crate::chat::types::SessionMetadata) -> bool {
    !metadata.queued_messages.is_empty()
        || metadata.to_session().waiting_for_input
        || !metadata.pending_permission_denials.is_empty()
        || !metadata.pending_codex_permission_requests.is_empty()
        || !metadata.pending_opencode_permission_requests.is_empty()
        || !metadata.pending_acp_permission_requests.is_empty()
        || !metadata.pending_codex_command_approval_requests.is_empty()
        || !metadata.pending_codex_user_input_requests.is_empty()
        || !metadata.pending_codex_mcp_elicitation_requests.is_empty()
        || !metadata.pending_codex_dynamic_tool_call_requests.is_empty()
}

async fn reattach_existing_run(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Result<bool, String> {
    #[cfg(test)]
    if let Some(fixture) = app.try_state::<CommandDriveFixture>() {
        fixture
            .reattached
            .lock()
            .map_err(|error| error.to_string())?
            .push(session_id.into());
        let mut metadata = crate::chat::storage::load_metadata(app, session_id)?
            .ok_or("Fixture metadata absent")?;
        metadata.runs[0].status = crate::chat::types::RunStatus::Completed;
        crate::chat::storage::save_metadata(app, &metadata)?;
        return Ok(true);
    }
    let result =
        crate::chat::resume_session(app.clone(), session_id.into(), worktree_id.into()).await?;
    Ok(result.resumed || crate::chat::registry::is_session_actively_managed(session_id))
}

async fn reconcile_session(
    app: &AppHandle,
    execution: &ValidationExecution,
    identity: &StepIdentity,
) -> Result<StepResult, String> {
    let session_id = execution
        .active_session_id
        .clone()
        .ok_or("Session manquante")?;
    let mut reattached = false;
    let metadata = loop {
        let metadata = crate::chat::storage::load_metadata(app, &session_id)?
            .ok_or("Manifest du run introuvable")?;
        if metadata.id != session_id || metadata.worktree_id != execution.worktree_id {
            return Err("Manifest du run non lié au worktree/session".into());
        }
        if session_requires_manual_reconciliation(&metadata) {
            return Err("Session avec prompts en attente ou décision/permission utilisateur requise ; réconciliation explicite nécessaire".into());
        }
        if metadata.runs.is_empty() {
            let messages = crate::chat::run_log::load_session_messages(app, &session_id)?;
            if messages
                .iter()
                .any(|message| matches!(message.role, crate::chat::types::MessageRole::User))
            {
                return Err("Session sans run mais contenant un prompt : réconciliation requise avant envoi".into());
            }
            return send_existing_session(app, execution, identity, session_id).await;
        }
        let run = metadata.runs.last().ok_or("Run manquant")?;
        let prompt_binding =
            historical_session_provenance(execution, &session_id, "", &run.user_message)
                .filter(|binding| {
                    binding.attempt_id == identity.attempt_id
                        && binding.step == identity.step
                        && prompt_step_identity(&run.user_message).as_ref() == Some(identity)
                })
                .map(|_| identity);
        // Establish immutable ownership before any attachment. Terminal success
        // is checked separately after the existing run has finished.
        orchestration::assert_run_binding(
            execution,
            &session_id,
            prompt_binding,
            metadata.runs.len(),
            run.cancelled || run.status == crate::chat::types::RunStatus::Cancelled,
            true,
        )?;
        if get(app, &execution.id)
            .is_ok_and(|latest| latest.paused || latest.superseded_by.is_some())
        {
            return Err("Worker interrompu par pause ou remplacement".into());
        }
        match run.status {
            crate::chat::types::RunStatus::Completed => break metadata,
            crate::chat::types::RunStatus::Resumable if !reattached => {
                reattached = true;
                if !reattach_existing_run(app, &session_id, &execution.worktree_id).await? {
                    return Err("Run récupérable non réattaché ; réconciliation explicite nécessaire, aucun prompt dupliqué".into());
                }
                continue;
            }
            crate::chat::types::RunStatus::Running | crate::chat::types::RunStatus::Resumable => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|error| error.to_string())?
                    .as_secs();
                if now.saturating_sub(run.started_at) >= 3600 {
                    return Err("Run agent toujours actif après une heure ; aucun second prompt envoyé. Reprise explicite après sa fin.".into());
                }
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            }
            _ => return Err("Run annulé ou non terminé avec succès ; résultat refusé".into()),
        }
    };
    let run = metadata.runs.last().ok_or("Run manquant")?;
    let assistant_id = run
        .assistant_message_id
        .as_deref()
        .ok_or("Run terminal sans message assistant lié ; réconciliation requise")?;
    let messages = crate::chat::run_log::load_session_messages(app, &session_id)?;
    let message = messages
        .iter()
        .find(|m| {
            m.id == assistant_id
                && m.session_id == session_id
                && matches!(m.role, crate::chat::types::MessageRole::Assistant)
        })
        .ok_or("Aucun résultat terminal récupérable ; le run doit être réconcilié avant reprise")?;
    if message.cancelled {
        return Err("Le run récupéré a été annulé".into());
    }
    let result = steps::parse_agent_result(&message.content, identity)?;
    reject_reserved_agent_fields(&result)?;
    Ok(result)
}

async fn preview_result(
    execution: &ValidationExecution,
    identity: StepIdentity,
) -> Result<StepResult, String> {
    let pr = execution.pr_number.ok_or("PR manquante")?;
    let url = super::preview_version::preview_url(pr)?;
    let deployed = match super::preview_version::fetch_preview_commit(pr).await {
        Ok(commit) => commit,
        Err(error) => {
            let mut waiting = basic_result(
                identity,
                execution.head_commit.clone().ok_or("Head manquant")?,
            );
            waiting.outcome = StepOutcome::Waiting;
            waiting.message = Some(format!("Preview pas encore disponible : {error}"));
            return Ok(waiting);
        }
    };
    let head = execution.head_commit.clone().ok_or("Head manquant")?;
    let path = std::path::Path::new(&execution.repository_path);
    if super::preview_version::verify_inclusion(path, &head, &deployed)
        == super::preview_version::PreviewInclusion::Unknown
    {
        steps::git(&execution.repository_path, &["fetch", "origin"])?;
        if super::preview_version::verify_inclusion(path, &head, &deployed)
            == super::preview_version::PreviewInclusion::Unknown
        {
            let merge_ref = format!("refs/pull/{pr}/merge");
            let _ = steps::git(&execution.repository_path, &["fetch", "origin", &merge_ref]);
            let _ = steps::git(&execution.repository_path, &["fetch", "origin", &deployed]);
        }
    }
    match super::preview_version::verify_inclusion(path, &head, &deployed) {
        super::preview_version::PreviewInclusion::Included => {}
        super::preview_version::PreviewInclusion::NotIncluded => {
            let mut waiting = basic_result(identity, head);
            waiting.outcome = StepOutcome::Waiting;
            waiting.message = Some(format!(
                "Déploiement en attente : version {deployed} ne contient pas encore le commit PR"
            ));
            return Ok(waiting);
        }
        super::preview_version::PreviewInclusion::Unknown => {
            return Err("Version non confirmée : inclusion non vérifiable".into())
        }
    }
    let mut result = basic_result(identity, head.clone());
    result.deployed_commit = Some(deployed.clone());
    result.evidence.push(Evidence {
        id: "preview-version".into(),
        label: "Commit PR inclus dans la version déployée".into(),
        kind: "git-ancestry".into(),
        value: format!("{url} — PR {head} → déployé {deployed}"),
        commit: head,
        stale: false,
    });
    Ok(result)
}

async fn remote_check(
    app: &AppHandle,
    execution: &ValidationExecution,
) -> Result<crate::jenkins::gh_checks::PrCheck, String> {
    let path = execution.repository_path.clone();
    let binary = crate::gh_cli::config::resolve_gh_binary(app);
    let pr = execution.pr_number.ok_or("PR manquante")?;
    tauri::async_runtime::spawn_blocking(move || {
        super::validation_ci::fetch_validation_pr_check(&path, &binary, pr)
    })
    .await
    .map_err(|e| e.to_string())?
}
async fn assert_remote_head(
    app: &AppHandle,
    execution: &ValidationExecution,
) -> Result<(), String> {
    if has_drive_fixture(app) {
        return Ok(());
    }
    let check = remote_check(app, execution).await?;
    if check.head_sha != execution.head_commit {
        return Err(
            "La PR distante a changé : résultats dépendants de la version à refaire".into(),
        );
    }
    Ok(())
}
async fn ci_result(
    app: &AppHandle,
    execution: &mut ValidationExecution,
    identity: &StepIdentity,
) -> Result<StepResult, String> {
    let check = remote_check(app, execution).await?;
    if check.head_sha != execution.head_commit {
        return Err("CI : head distant différent du commit testé".into());
    }
    let head = execution.head_commit.clone().ok_or("HEAD manquant")?;
    let mut result = basic_result(identity.clone(), head.clone());
    match check.verdict.as_deref() {
        Some("SUCCESS") => {
            add_ci_proof(&mut result, execution.pr_number.unwrap_or_default());
        }
        Some("FAILURE") => {
            result = execute_agent(app, execution, identity).await?;
            result.outcome = StepOutcome::CorrectionRequired;
            if result.defects.is_empty() {
                result.defects.push(Defect {
                    id: "ci-failure".into(),
                    description: "CI rouge sur le head testé ; diagnostiquer avant correction"
                        .into(),
                    mandatory: true,
                    resolved: false,
                    evidence_ids: vec![],
                });
            }
        }
        _ => {
            result.outcome = StepOutcome::Waiting;
            result.message = Some("CI en cours ou aucun résultat pour ce head".into());
        }
    }
    Ok(result)
}

fn reject_reserved_agent_fields(result: &StepResult) -> Result<(), String> {
    if result.deployed_commit.is_some()
        || result
            .requirements
            .iter()
            .any(|r| r.id == "ci-head" || r.id == "preview-version")
        || result.evidence.iter().any(|e| {
            e.id == "ci-head"
                || e.id == "preview-version"
                || e.kind == "backend-ci"
                || e.kind == "git-ancestry"
        })
    {
        return Err("Un résultat agent tente de remplacer une preuve réservée au backend".into());
    }
    Ok(())
}
async fn criteria_fingerprint(
    app: &AppHandle,
    execution: &ValidationExecution,
) -> Result<String, String> {
    if has_drive_fixture(app) {
        return Ok("isolated-fixture-criteria".into());
    }
    use sha2::{Digest, Sha256};
    let token = crate::projects::resolve_clickup_token(app, Some(&execution.project_id))?;
    let task = crate::projects::clickup_client::clickup_get(
        &token,
        &format!("/task/{}", execution.task_id),
    )
    .await?;
    super::commands::verify_ai_pipeline_pickup_status(
        task.get("status")
            .and_then(|status| status.get("status"))
            .and_then(|status| status.as_str()),
    )?;
    let me =
        crate::projects::get_clickup_me(app.clone(), Some(execution.project_id.clone())).await?;
    if !task
        .get("assignees")
        .and_then(|v| v.as_array())
        .is_some_and(|users| {
            users
                .iter()
                .any(|user| user.get("id").and_then(|id| id.as_i64()) == Some(me.id))
        })
    {
        return Err(
            "Prise en charge ClickUp non confirmée : ticket non assigné à ton compte".into(),
        );
    }
    let criteria = serde_json::json!({ "name": task.get("name"), "description": task.get("description"), "text_content": task.get("text_content"), "custom_fields": task.get("custom_fields") });
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&criteria).map_err(|e| e.to_string())?)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn resume_command_rejects_conflicting_persisted_owners_without_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let app =
            crate::RuntimeContext::new(temporary.path().into(), temporary.path().into()).unwrap();
        let mut failed = ValidationExecution::new(
            "p".into(),
            "w".into(),
            "/not-accessed".into(),
            "t".into(),
            Some(42),
        );
        failed.status = ValidationStatus::Failed;
        failed.step = ValidationStep::Correction;
        let review = ValidationExecution::new(
            "p".into(),
            "w".into(),
            "/not-accessed".into(),
            "t".into(),
            Some(42),
        );
        save(&app, &failed).unwrap();
        save(&app, &review).unwrap();
        let before = serde_json::to_value(get(&app, &failed.id).unwrap()).unwrap();
        let error = resume_ai_pipeline_validation(app.clone(), failed.id.clone())
            .await
            .unwrap_err();
        assert!(error.contains("Plusieurs validations"), "{error}");
        assert_eq!(
            before,
            serde_json::to_value(get(&app, &failed.id).unwrap()).unwrap()
        );
        assert_eq!(store(&app).unwrap().list().unwrap().len(), 2);
    }

    #[test]
    fn worker_consumption_preserves_concurrent_pause_and_rejects_replacement() {
        let temporary = tempfile::tempdir().unwrap();
        let app =
            crate::RuntimeContext::new(temporary.path().into(), temporary.path().into()).unwrap();
        let mut execution = ValidationExecution::new(
            "p".into(),
            "w".into(),
            "/not-accessed".into(),
            "t".into(),
            Some(42),
        );
        engine::begin_attempt(&mut execution).unwrap();
        save(&app, &execution).unwrap();
        let mut persisted = execution.clone();
        engine::pause(&mut persisted);
        save(&app, &persisted).unwrap();
        execution.active_attempt = None;
        execution.revision += 1;
        save_worker(&app, &mut execution).unwrap();
        assert!(get(&app, &execution.id).unwrap().paused);
        let mut replaced = get(&app, &execution.id).unwrap();
        replaced.superseded_by = Some(uuid::Uuid::new_v4().to_string());
        save(&app, &replaced).unwrap();
        assert!(save_worker(&app, &mut execution).is_err());
        assert!(get(&app, &execution.id).unwrap().superseded_by.is_some());
    }

    #[test]
    fn consumed_result_cannot_overwrite_newer_attempt_even_after_clearing_active() {
        let temporary = tempfile::tempdir().unwrap();
        let app =
            crate::RuntimeContext::new(temporary.path().into(), temporary.path().into()).unwrap();
        let mut worker = ValidationExecution::new(
            "p".into(),
            "w".into(),
            "/not-accessed".into(),
            "t".into(),
            Some(42),
        );
        let consumed = engine::begin_attempt(&mut worker).unwrap();
        let mut persisted = worker.clone();
        persisted.active_attempt.as_mut().unwrap().attempt_id = "newer-attempt".into();
        save(&app, &persisted).unwrap();
        worker.active_attempt = None;
        assert!(save_worker_checked(&app, &mut worker, Some(&consumed)).is_err());
        assert_eq!(
            get(&app, &worker.id)
                .unwrap()
                .active_attempt
                .unwrap()
                .attempt_id,
            "newer-attempt"
        );
    }

    #[tokio::test]
    async fn reconciliation_rejects_unrelated_and_cancelled_persisted_runs_before_loading_output() {
        let temporary = tempfile::tempdir().unwrap();
        let app =
            crate::RuntimeContext::new(temporary.path().into(), temporary.path().into()).unwrap();
        let mut execution = ValidationExecution::new(
            "p".into(),
            "w".into(),
            "/not-accessed".into(),
            "t".into(),
            Some(42),
        );
        let identity = engine::begin_attempt(&mut execution).unwrap();
        execution.record_agent_session("isolated-session".into(), &identity);
        let mut metadata = crate::chat::types::SessionMetadata::new(
            "isolated-session".into(),
            "w".into(),
            "test".into(),
            0,
        );
        let mut run: crate::chat::types::RunEntry = serde_json::from_value(serde_json::json!({
            "run_id": "run", "user_message_id": "user", "user_message": "unrelated prompt", "started_at": 1, "status": "completed", "assistant_message_id": "assistant"
        })).unwrap();
        metadata.runs.push(run.clone());
        crate::chat::storage::save_metadata(&app, &metadata).unwrap();
        assert!(reconcile_session(&app, &execution, &identity)
            .await
            .unwrap_err()
            .contains("non lié"));
        run.user_message = steps::prompt(&execution, &identity).unwrap();
        run.cancelled = true;
        metadata.runs[0] = run;
        crate::chat::storage::save_metadata(&app, &metadata).unwrap();
        assert!(reconcile_session(&app, &execution, &identity)
            .await
            .unwrap_err()
            .contains("annulé"));
        assert_eq!(
            crate::chat::storage::load_metadata(&app, "isolated-session")
                .unwrap()
                .unwrap()
                .runs
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn repair_prompt_without_proven_source_never_reexecutes_step() {
        let temporary = tempfile::tempdir().unwrap();
        let app =
            crate::RuntimeContext::new(temporary.path().into(), temporary.path().into()).unwrap();
        let mut execution = ValidationExecution::new(
            "p".into(),
            "w".into(),
            "/not-accessed".into(),
            "t".into(),
            Some(42),
        );
        execution.agent_result_repair_retries = 1;
        let identity = engine::begin_attempt(&mut execution).unwrap();
        assert!(agent_prompt(&app, &execution, &identity, "new-session")
            .await
            .unwrap_err()
            .contains("aucun travail rejoué"));
        execution.agent_result_repair_source_session = Some("new-session".into());
        assert!(agent_prompt(&app, &execution, &identity, "new-session")
            .await
            .unwrap_err()
            .contains("ne peut pas être la source"));
    }

    #[tokio::test]
    async fn reconciliation_consumes_bound_terminal_output_and_formatter_never_repeats_work() {
        let temporary = tempfile::tempdir().unwrap();
        let app =
            crate::RuntimeContext::new(temporary.path().into(), temporary.path().into()).unwrap();
        let mut execution = ValidationExecution::new(
            "p".into(),
            "w".into(),
            "/not-accessed".into(),
            "t".into(),
            Some(42),
        );
        execution.head_commit = Some("head".into());
        let identity = engine::begin_attempt(&mut execution).unwrap();
        execution.record_agent_session("source-session".into(), &identity);
        let prompt = steps::prompt(&execution, &identity).unwrap();
        let mut metadata = crate::chat::types::SessionMetadata::new(
            "source-session".into(),
            "w".into(),
            "test".into(),
            0,
        );
        let run: crate::chat::types::RunEntry = serde_json::from_value(serde_json::json!({
            "run_id": "run", "user_message_id": "user", "user_message": prompt, "started_at": 1, "status": "completed", "assistant_message_id": "assistant"
        })).unwrap();
        metadata.runs.push(run.clone());
        crate::chat::storage::save_metadata(&app, &metadata).unwrap();
        let result = basic_result(identity.clone(), "head".into());
        let output = serde_json::to_string(&result).unwrap();
        let path = crate::chat::run_log::get_run_log_path(&app, "source-session", "run").unwrap();
        let write_output = |content: &str| {
            let assistant = serde_json::json!({"type":"assistant", "message":{"role":"assistant", "content":[{"type":"text", "text":content}]}});
            std::fs::write(
                &path,
                format!("{assistant}\n{{\"type\":\"result\",\"is_error\":false}}\n"),
            )
            .unwrap();
        };
        write_output(&output);
        let recovered = reconcile_session(&app, &execution, &identity)
            .await
            .unwrap();
        assert_eq!(recovered.identity, identity);
        assert_eq!(recovered.commit, "head");
        metadata.runs.push(run);
        crate::chat::storage::save_metadata(&app, &metadata).unwrap();
        assert!(reconcile_session(&app, &execution, &identity)
            .await
            .unwrap_err()
            .contains("non lié"));
        metadata.runs.truncate(1);
        crate::chat::storage::save_metadata(&app, &metadata).unwrap();
        write_output("Le test est rouge. Ne prétends pas une réussite.");
        execution.agent_result_repair_retries = 1;
        execution.agent_result_repair_source_session = Some("source-session".into());
        execution.active_attempt = None;
        execution.active_session_id = None;
        let repair_identity = engine::begin_attempt(&mut execution).unwrap();
        let repair_prompt = agent_prompt(&app, &execution, &repair_identity, "repair-session")
            .await
            .unwrap();
        assert!(repair_prompt.contains("RÉPARATION DE FORMAT, AUCUNE EXÉCUTION"));
        assert!(repair_prompt.contains("n'appelle aucun outil"));
        assert!(repair_prompt.contains("Le test est rouge"));
        assert!(repair_prompt.contains("n'invente aucune preuve"));
        assert!(!repair_prompt.contains("Review indépendante du ticket et de la PR"));
        assert_eq!(
            crate::chat::storage::load_metadata(&app, "source-session")
                .unwrap()
                .unwrap()
                .runs
                .len(),
            1
        );
    }

    #[test]
    fn dirty_retry_requires_exact_owned_tree_and_head_not_blanket_permission() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().to_string_lossy().into_owned();
        let git = |args: &[&str]| {
            let output = crate::platform::silent_command("git")
                .args(args)
                .current_dir(&path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "isolated-test"]);
        git(&["config", "user.email", "isolated@example.invalid"]);
        std::fs::write(temporary.path().join("owned.txt"), "original").unwrap();
        git(&["add", "owned.txt"]);
        git(&["commit", "-qm", "initial"]);
        let mut execution =
            ValidationExecution::new("p".into(), "w".into(), path, "t".into(), Some(42));
        execution.step = ValidationStep::Correction;
        execution.head_commit =
            Some(steps::git(&execution.repository_path, &["rev-parse", "HEAD"]).unwrap());
        std::fs::write(temporary.path().join("owned.txt"), "agent correction").unwrap();
        assert!(verify_owned_worktree(&execution).is_err());
        execution.owned_worktree_fingerprint = Some(
            super::super::runtime_config::working_tree_fingerprint(
                &execution.repository_path,
                None,
            )
            .unwrap(),
        );
        verify_owned_worktree(&execution).unwrap();
        std::fs::write(temporary.path().join("owned.txt"), "foreign edit same path").unwrap();
        assert!(verify_owned_worktree(&execution)
            .unwrap_err()
            .contains("extérieures"));
        std::fs::write(temporary.path().join("owned.txt"), "agent correction").unwrap();
        verify_owned_worktree(&execution).unwrap();
        std::fs::write(temporary.path().join("foreign.txt"), "foreign untracked").unwrap();
        assert!(verify_owned_worktree(&execution).is_err());
    }

    #[test]
    fn startup_recovery_leaves_manual_terminal_paused_and_superseded_snapshots_untouched() {
        let temporary = tempfile::tempdir().unwrap();
        let app =
            crate::RuntimeContext::new(temporary.path().into(), temporary.path().into()).unwrap();
        for (index, status) in [
            ValidationStatus::Blocked,
            ValidationStatus::Failed,
            ValidationStatus::Ready,
            ValidationStatus::Running,
            ValidationStatus::Pending,
        ]
        .into_iter()
        .enumerate()
        {
            let mut execution = ValidationExecution::new(
                "p".into(),
                format!("w-{index}"),
                "/not-accessed".into(),
                "t".into(),
                Some(42),
            );
            execution.status = status;
            if status == ValidationStatus::Running {
                execution.paused = true;
            }
            if status == ValidationStatus::Pending {
                execution.superseded_by = Some(uuid::Uuid::new_v4().to_string());
            }
            save(&app, &execution).unwrap();
        }
        let before = serde_json::to_value(store(&app).unwrap().list().unwrap()).unwrap();
        recover_ai_pipeline_validations(app.clone()).unwrap();
        assert_eq!(
            before,
            serde_json::to_value(store(&app).unwrap().list().unwrap()).unwrap()
        );
        let jobs = JOBS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap();
        assert!(store(&app)
            .unwrap()
            .list()
            .unwrap()
            .iter()
            .all(|execution| !jobs.contains(&execution.id)));
    }

    fn drive_test_fixture(
        agents: Vec<(ValidationStep, StepOutcome, Option<String>)>,
    ) -> (tempfile::TempDir, AppHandle, ValidationExecution) {
        let temporary = tempfile::tempdir().unwrap();
        let app = crate::RuntimeContext::new(
            temporary.path().join("data"),
            temporary.path().join("resources"),
        )
        .unwrap();
        let repo = temporary.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            let output = crate::platform::silent_command("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q", "-b", "isolated-branch"]);
        git(&["config", "user.name", "isolated-test"]);
        git(&["config", "user.email", "isolated@example.invalid"]);
        std::fs::write(repo.join("owned.txt"), "original").unwrap();
        git(&["add", "owned.txt"]);
        git(&["commit", "-qm", "initial"]);
        let worktree: crate::projects::types::Worktree = serde_json::from_value(serde_json::json!({
            "id":"w", "project_id":"p", "name":"isolated", "path":repo, "branch":"isolated-branch", "created_at":1
        })).unwrap();
        let data = crate::projects::types::ProjectsData {
            projects: vec![],
            worktrees: vec![worktree],
        };
        crate::projects::storage::save_projects_data(&app, &data).unwrap();
        app.manage(CommandDriveFixture {
            reattached: Mutex::new(vec![]),
            observed: Mutex::new(vec![]),
            agents: Mutex::new(agents.into()),
        });
        let mut execution = ValidationExecution::new(
            "p".into(),
            "w".into(),
            repo.to_string_lossy().into_owned(),
            "t".into(),
            Some(42),
        );
        execution.step = ValidationStep::Correction;
        execution.original_branch = Some("isolated-branch".into());
        execution.head_commit =
            Some(steps::git(&execution.repository_path, &["rev-parse", "HEAD"]).unwrap());
        (temporary, app, execution)
    }

    fn remote_integration_drive_fixture(
    ) -> (tempfile::TempDir, AppHandle, ValidationExecution, String) {
        let (temporary, app, mut execution) =
            drive_test_fixture(vec![(ValidationStep::Review, StepOutcome::Blocked, None)]);
        let path = execution.repository_path.clone();
        let remote = temporary.path().join("remote.git");
        steps::git(&path, &["init", "--bare", remote.to_str().unwrap()]).unwrap();
        steps::git(
            &path,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        )
        .unwrap();
        steps::git(&path, &["push", "origin", "isolated-branch"]).unwrap();
        let bot = temporary.path().join("bot");
        steps::git(
            &path,
            &[
                "clone",
                "-b",
                "isolated-branch",
                remote.to_str().unwrap(),
                bot.to_str().unwrap(),
            ],
        )
        .unwrap();
        let bot_path = bot.to_str().unwrap();
        steps::git(bot_path, &["config", "user.name", "bot"]).unwrap();
        steps::git(bot_path, &["config", "user.email", "bot@example.invalid"]).unwrap();
        std::fs::write(bot.join("remote.txt"), "remote integration").unwrap();
        steps::git(bot_path, &["add", "remote.txt"]).unwrap();
        steps::git(bot_path, &["commit", "-m", "remote update"]).unwrap();
        steps::git(bot_path, &["push", "origin", "isolated-branch"]).unwrap();
        let remote_head = steps::git(bot_path, &["rev-parse", "HEAD"]).unwrap();
        std::fs::write(
            std::path::Path::new(&path).join("local.txt"),
            "local correction",
        )
        .unwrap();
        steps::git(&path, &["add", "local.txt"]).unwrap();
        steps::git(&path, &["commit", "-m", "local correction"]).unwrap();
        execution.head_commit = Some(steps::git(&path, &["rev-parse", "HEAD"]).unwrap());
        let before = execution.head_commit.clone().unwrap();
        execution.step = ValidationStep::GitSync;
        execution.correction_cycles = 1;
        execution.publication_remote_identity =
            Some(super::super::validation_publication::capture_remote_identity(&path).unwrap());
        execution.effects.push(ExternalEffect {
            id: "legacy-push".into(),
            kind: "push".into(),
            intended_commit: before.clone(),
            confirmed: false,
        });
        execution.evidence.push(Evidence {
            id: "old".into(),
            label: "old proof".into(),
            kind: "test".into(),
            value: "passed".into(),
            commit: before.clone(),
            stale: false,
        });
        (temporary, app, execution, remote_head)
    }

    #[tokio::test]
    async fn actual_drive_remote_update_integrates_then_reviews_before_any_push() {
        let (temporary, app, mut execution, remote_head) = remote_integration_drive_fixture();
        execution.publication_remote_identity = None; // Legacy existing PR snapshot.
        let path = execution.repository_path.clone();
        let remote = temporary.path().join("remote.git");
        let before = execution.head_commit.clone().unwrap();
        save(&app, &execution).unwrap();
        drive(&app, &execution.id).await.unwrap();
        let terminal = get(&app, &execution.id).unwrap();
        assert_eq!(terminal.step, ValidationStep::Review);
        assert_eq!(terminal.status, ValidationStatus::Blocked);
        assert_ne!(terminal.head_commit.as_ref(), Some(&before));
        assert_eq!(terminal.correction_cycles, 1);
        assert_eq!(
            terminal.publication_remote_identity,
            Some(super::super::validation_publication::capture_remote_identity(&path).unwrap())
        );
        assert!(terminal.evidence.iter().all(|proof| proof.stale));
        assert_eq!(
            steps::git(
                remote.to_str().unwrap(),
                &["rev-parse", "refs/heads/isolated-branch"]
            )
            .unwrap(),
            remote_head
        );
        assert!(std::path::Path::new(&path).join("local.txt").exists());
        assert!(std::path::Path::new(&path).join("remote.txt").exists());
        assert!(terminal.effects.iter().all(|effect| effect.kind != "push"));
    }

    #[test]
    fn late_remote_divergence_retry_is_bounded_and_never_retries_unknown_push_errors() {
        let mut retries = 0;
        assert!(!retry_remote_divergence(
            "Push failed after network disconnect",
            &mut retries
        ));
        assert!(!retry_remote_divergence(
            "La base distante a avancé ; première publication refusée",
            &mut retries
        ));
        assert_eq!(retries, 0);
        let divergence =
            "La branche feature distante a divergé ; intégration puis nouvelle review requises";
        assert!(retry_remote_divergence(divergence, &mut retries));
        assert!(retry_remote_divergence(divergence, &mut retries));
        assert!(!retry_remote_divergence(divergence, &mut retries));
        assert_eq!(retries, 2);
    }

    #[tokio::test]
    async fn remote_integration_recovers_only_exact_completed_merge_then_reviews() {
        let (_temporary, app, mut execution, _) = remote_integration_drive_fixture();
        let plan = super::super::validation_publication::prepare_remote_integration(&execution)
            .unwrap()
            .unwrap();
        execution.pending_git_integration = Some(plan.clone());
        execution.remote_integration_attempts = 1;
        engine::begin_attempt(&mut execution).unwrap();
        save(&app, &execution).unwrap();
        let merged =
            super::super::validation_publication::execute_remote_integration(&execution, &plan)
                .unwrap();
        drive(&app, &execution.id).await.unwrap();
        let current = get(&app, &execution.id).unwrap();
        assert_eq!(current.head_commit.as_deref(), Some(merged.as_str()));
        assert_eq!(current.step, ValidationStep::Review);
        assert_eq!(current.remote_integration_attempts, 1);
        assert!(current.pending_git_integration.is_none());
        assert_eq!(
            steps::git(&execution.repository_path, &["rev-parse", "HEAD"]).unwrap(),
            merged
        );
        assert_eq!(
            current
                .effects
                .iter()
                .filter(|effect| effect.kind == "git_integration")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn remote_integration_never_adopts_manual_head_or_merges_after_pause_or_budget() {
        // Refuse a foreign commit even with a persisted integration intent.
        let (_temporary, app, mut execution, _) = remote_integration_drive_fixture();
        let plan = super::super::validation_publication::prepare_remote_integration(&execution)
            .unwrap()
            .unwrap();
        execution.pending_git_integration = Some(plan);
        engine::begin_attempt(&mut execution).unwrap();
        save(&app, &execution).unwrap();
        steps::git(
            &execution.repository_path,
            &["commit", "--allow-empty", "-m", "manual commit"],
        )
        .unwrap();
        let foreign = steps::git(&execution.repository_path, &["rev-parse", "HEAD"]).unwrap();
        assert!(drive(&app, &execution.id)
            .await
            .unwrap_err()
            .contains("fusion distante prévue"));
        assert_eq!(
            steps::git(&execution.repository_path, &["rev-parse", "HEAD"]).unwrap(),
            foreign
        );
        assert_eq!(
            get(&app, &execution.id).unwrap().head_commit,
            execution.head_commit
        );

        // An explicit pause prevents the pending Git operation from starting.
        let (_temporary, app, mut execution, _) = remote_integration_drive_fixture();
        let plan = super::super::validation_publication::prepare_remote_integration(&execution)
            .unwrap()
            .unwrap();
        execution.pending_git_integration = Some(plan);
        let identity = engine::begin_attempt(&mut execution).unwrap();
        let mut paused = execution.clone();
        engine::pause(&mut paused);
        save(&app, &paused).unwrap();
        assert!(
            integrate_remote_before_publication(&app, &mut execution, &identity)
                .await
                .unwrap()
        );
        assert_eq!(
            steps::git(&execution.repository_path, &["rev-parse", "HEAD"]).unwrap(),
            execution.head_commit.unwrap()
        );
        assert!(get(&app, &execution.id).unwrap().paused);

        // No fourth remote integration and no reset of the functional correction budget.
        let (_temporary, app, mut execution, _) = remote_integration_drive_fixture();
        execution.remote_integration_attempts = 3;
        save(&app, &execution).unwrap();
        let error = drive(&app, &execution.id).await.unwrap_err();
        assert!(error.contains("3 intégrations maximum"), "{error}");
        let current = get(&app, &execution.id).unwrap();
        assert_eq!(current.remote_integration_attempts, 3);
        assert_eq!(current.correction_cycles, 1);
        assert_eq!(
            steps::git(&execution.repository_path, &["rev-parse", "HEAD"]).unwrap(),
            execution.head_commit.unwrap()
        );
    }

    #[tokio::test]
    async fn actual_drive_failed_dirty_correction_retries_same_owner_commits_then_reviews() {
        let (_temporary, app, execution) = drive_test_fixture(vec![
            (
                ValidationStep::Correction,
                StepOutcome::Failed,
                Some("agent red partial correction".into()),
            ),
            (
                ValidationStep::Correction,
                StepOutcome::Passed,
                Some("agent corrected green".into()),
            ),
            (ValidationStep::Review, StepOutcome::Blocked, None),
        ]);
        let initial_head = execution.head_commit.clone();
        save(&app, &execution).unwrap();
        drive(&app, &execution.id).await.unwrap();
        let terminal = get(&app, &execution.id).unwrap();
        assert_eq!(terminal.status, ValidationStatus::Blocked);
        let fixture = app.state::<CommandDriveFixture>();
        let observed = fixture.observed.lock().unwrap();
        assert_eq!(observed.len(), 3);
        let retry = &observed[1];
        assert_eq!(retry.id, execution.id);
        assert_eq!(retry.correction_cycles, 1);
        assert_eq!(retry.head_commit, initial_head);
        assert!(retry.owned_worktree_fingerprint.is_some());
        assert_eq!(retry.step, ValidationStep::Correction);
        drop(observed);
        assert_eq!(terminal.step, ValidationStep::Review);
        assert_eq!(terminal.correction_cycles, 2);
        assert_ne!(terminal.head_commit, initial_head);
        assert!(terminal.owned_worktree_fingerprint.is_none());
        assert!(steps::is_clean(&terminal).unwrap());
        assert!(terminal
            .effects
            .iter()
            .any(|effect| effect.kind == "commit" && effect.confirmed));
        assert_eq!(
            steps::git(&terminal.repository_path, &["log", "-1", "--format=%s"]).unwrap(),
            "fix: address review findings"
        );
        let states = store(&app).unwrap().list().unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(
            orchestration::canonical_execution(&states, "w")
                .unwrap()
                .unwrap()
                .id,
            execution.id
        );
        assert!(app
            .state::<CommandDriveFixture>()
            .agents
            .lock()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn actual_drive_repeated_failed_correction_stops_budget_without_commit() {
        let (_temporary, app, execution) = drive_test_fixture(vec![
            (
                ValidationStep::Correction,
                StepOutcome::Failed,
                Some("first failed changes".into()),
            ),
            (
                ValidationStep::Correction,
                StepOutcome::Failed,
                Some("second failed changes".into()),
            ),
        ]);
        save(&app, &execution).unwrap();
        drive(&app, &execution.id).await.unwrap();
        let terminal = get(&app, &execution.id).unwrap();
        assert_eq!(terminal.status, ValidationStatus::Blocked);
        assert_eq!(terminal.step, ValidationStep::Correction);
        assert_eq!(terminal.head_commit, execution.head_commit);
        assert_eq!(terminal.no_progress_cycles, 2);
        assert_eq!(terminal.correction_cycles, 2);
        assert!(terminal.effects.is_empty());
        assert!(terminal.owned_worktree_fingerprint.is_some());
        assert!(terminal.blocker.unwrap().contains("Limite"));
        assert_eq!(store(&app).unwrap().list().unwrap().len(), 1);
        assert!(resume_ai_pipeline_validation(app.clone(), execution.id)
            .await
            .unwrap_err()
            .contains("Limite"));
    }

    #[tokio::test]
    async fn actual_drive_recovers_persisted_terminal_attempt_without_replaying_agent() {
        exercise_persisted_attempt_recovery("completed").await;
    }
    #[tokio::test]
    async fn actual_drive_reattaches_resumable_attempt_without_replaying_agent() {
        exercise_persisted_attempt_recovery("resumable").await;
    }
    async fn exercise_persisted_attempt_recovery(status: &str) {
        let (_temporary, app, mut execution) =
            drive_test_fixture(vec![(ValidationStep::Review, StepOutcome::Blocked, None)]);
        let identity = engine::begin_attempt(&mut execution).unwrap();
        execution.record_agent_session("persisted-session".into(), &identity);
        let prompt = steps::prompt(&execution, &identity).unwrap();
        let mut metadata = crate::chat::types::SessionMetadata::new(
            "persisted-session".into(),
            "w".into(),
            "test".into(),
            0,
        );
        metadata.runs.push(serde_json::from_value(serde_json::json!({
            "run_id":"run", "user_message_id":"user", "user_message":prompt, "started_at":1, "status":status, "assistant_message_id":"assistant"
        })).unwrap());
        crate::chat::storage::save_metadata(&app, &metadata).unwrap();
        let result = basic_result(identity, execution.head_commit.clone().unwrap());
        let assistant = serde_json::json!({"type":"assistant", "message":{"role":"assistant", "content":[{"type":"text", "text":serde_json::to_string(&result).unwrap()}]}});
        let path =
            crate::chat::run_log::get_run_log_path(&app, "persisted-session", "run").unwrap();
        std::fs::write(
            path,
            format!("{assistant}\n{{\"type\":\"result\",\"is_error\":false}}\n"),
        )
        .unwrap();
        std::fs::write(
            std::path::Path::new(&execution.repository_path).join("owned.txt"),
            "completed agent correction",
        )
        .unwrap();
        save(&app, &execution).unwrap();
        drive(&app, &execution.id).await.unwrap();
        let terminal = get(&app, &execution.id).unwrap();
        assert_eq!(
            app.state::<CommandDriveFixture>()
                .reattached
                .lock()
                .unwrap()
                .len(),
            usize::from(status == "resumable")
        );
        assert_eq!(terminal.status, ValidationStatus::Blocked);
        assert_eq!(terminal.step, ValidationStep::Review);
        assert_ne!(terminal.head_commit, execution.head_commit);
        assert!(terminal
            .effects
            .iter()
            .any(|effect| effect.kind == "commit" && effect.confirmed));
        assert_eq!(
            app.state::<CommandDriveFixture>()
                .observed
                .lock()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            crate::chat::storage::load_metadata(&app, "persisted-session")
                .unwrap()
                .unwrap()
                .runs
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn resumable_session_with_user_decision_or_queued_prompt_is_not_reattached() {
        let (_temporary, app, mut execution) = drive_test_fixture(vec![]);
        let identity = engine::begin_attempt(&mut execution).unwrap();
        execution.record_agent_session("manual-session".into(), &identity);
        let mut metadata = crate::chat::types::SessionMetadata::new(
            "manual-session".into(),
            "w".into(),
            "test".into(),
            0,
        );
        metadata.runs.push(serde_json::from_value(serde_json::json!({
            "run_id":"run", "user_message_id":"user", "user_message":steps::prompt(&execution, &identity).unwrap(), "started_at":1, "status":"resumable"
        })).unwrap());
        metadata.waiting_for_input = true;
        crate::chat::storage::save_metadata(&app, &metadata).unwrap();
        assert!(reconcile_session(&app, &execution, &identity)
            .await
            .unwrap_err()
            .contains("décision"));
        metadata.waiting_for_input = false;
        metadata
            .queued_messages
            .push(serde_json::json!({"content":"unrelated prompt"}));
        crate::chat::storage::save_metadata(&app, &metadata).unwrap();
        assert!(reconcile_session(&app, &execution, &identity)
            .await
            .unwrap_err()
            .contains("prompts en attente"));
        assert!(app
            .state::<CommandDriveFixture>()
            .reattached
            .lock()
            .unwrap()
            .is_empty());
        assert_eq!(
            crate::chat::storage::load_metadata(&app, "manual-session")
                .unwrap()
                .unwrap()
                .runs[0]
                .status,
            crate::chat::types::RunStatus::Resumable
        );
    }

    #[test]
    fn saved_snapshot_broadcasts_after_persistence_but_failed_save_never_broadcasts() {
        let temporary = tempfile::tempdir().unwrap();
        let app =
            crate::RuntimeContext::new(temporary.path().into(), temporary.path().into()).unwrap();
        let execution = ValidationExecution::new(
            "p".into(),
            "w".into(),
            "/not-accessed".into(),
            "t".into(),
            Some(42),
        );
        let received = std::sync::Arc::new(Mutex::new(Vec::new()));
        let events = received.clone();
        let observer = app.clone();
        let id = execution.id.clone();
        app.listen("cache:invalidate", move |event| {
            assert!(
                store(&observer).unwrap().get(&id).unwrap().is_some(),
                "event must follow durable save"
            );
            events.lock().unwrap().push(event.payload().to_string());
        });
        save(&app, &execution).unwrap();
        assert_eq!(received.lock().unwrap().len(), 1);
        assert!(received.lock().unwrap()[0].contains("ai-pipeline-validations"));
        let mut invalid = execution;
        invalid.id = "invalid-id".into();
        assert!(save(&app, &invalid).is_err());
        assert_eq!(received.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn explicit_resume_grants_new_wait_window_without_resetting_failure_budgets() {
        let (_temporary, app, mut execution) = drive_test_fixture(vec![(
            ValidationStep::Correction,
            StepOutcome::Blocked,
            None,
        )]);
        execution.status = ValidationStatus::Blocked;
        execution.blocker =
            Some("Attente externe dépassée (30 minutes) ; reprise explicite disponible".into());
        execution.waiting_since =
            Some((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
        execution.correction_cycles = 1;
        execution.no_progress_cycles = 1;
        save(&app, &execution).unwrap();
        let resumed = resume_ai_pipeline_validation(app.clone(), execution.id.clone())
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if get(&app, &execution.id).unwrap().status == ValidationStatus::Blocked {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            resumed.waiting_since.is_none(),
            "explicit retry must not inherit an already expired external wait"
        );
        assert_eq!(resumed.correction_cycles, 1);
        assert_eq!(resumed.no_progress_cycles, 1);
        assert_eq!(resumed.head_commit, execution.head_commit);
    }

    #[test]
    fn historical_index_read_never_creates_missing_storage() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("missing-worktree").join("index.json");
        assert!(read_historical_session_index(&path).is_none());
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
    }

    #[test]
    fn historical_session_provenance_requires_structured_execution_binding() {
        let mut execution = ValidationExecution::new(
            "project".into(),
            "worktree".into(),
            "/repo".into(),
            "task".into(),
            Some(42),
        );
        let identity = StepIdentity {
            execution_id: execution.id.clone(),
            step: ValidationStep::Review,
            attempt_id: "attempt".into(),
            input_revision: 1,
        };
        execution.active_attempt = Some(identity.clone());
        execution.record_agent_session("session".into(), &identity);
        let prompt = steps::prompt(&execution, &identity).unwrap();
        let session = historical_session_provenance(
            &execution,
            "session",
            "Validation privée · Review",
            &prompt,
        )
        .unwrap();
        assert_eq!(session.attempt_id, "attempt");
        assert!(historical_session_provenance(
            &execution,
            "session",
            "Validation privée · Review",
            "manual prompt"
        )
        .is_none());
        assert!(historical_session_provenance(
            &execution,
            "session",
            "Review privée ticket PR",
            &prompt
        )
        .is_some());
        assert!(historical_session_provenance(
            &execution,
            "copied-session",
            "Review privée ticket PR",
            &prompt
        )
        .is_none());
        let mismatched_attempt = prompt.replace("\"input_revision\": 1", "\"input_revision\": 2");
        assert!(historical_session_provenance(
            &execution,
            "session",
            "Review privée ticket PR",
            &mismatched_attempt
        )
        .is_none());
        let mut wrong = execution.clone();
        wrong.worktree_id = "other".into();
        assert!(historical_session_provenance(
            &wrong,
            "session",
            "Validation privée · Review",
            &prompt
        )
        .is_none());
        wrong = execution.clone();
        wrong.id = "other".into();
        assert!(historical_session_provenance(
            &wrong,
            "session",
            "Validation privée · Review",
            &prompt
        )
        .is_none());
        let wrong_identity = prompt.replace("\"attempt\"", "\"\"");
        assert!(historical_session_provenance(
            &execution,
            "session",
            "Validation privée · Review",
            &wrong_identity
        )
        .is_none());
    }
    #[test]
    fn publication_remote_anchor_is_required_and_must_match() {
        assert!(verify_publication_remote_identity(None, "identity").is_err());
        assert!(verify_publication_remote_identity(Some("foreign"), "identity").is_err());
        assert!(verify_publication_remote_identity(Some("identity"), "identity").is_ok());
    }

    #[test]
    fn legacy_missing_pr_migration_matches_only_known_blockers() {
        assert!(legacy_missing_pr_blocker(Some(
            "Une PR existante est requise pour vérifier la CI et la preview."
        )));
        assert!(legacy_missing_pr_blocker(Some("Ticket récupéré sans PR : l'implémentation et la création d'une PR sont requises avant cette validation de revue/recette.")));
        assert!(!legacy_missing_pr_blocker(Some(
            "Ticket récupéré sans PR mais modifié"
        )));
        assert!(!legacy_missing_pr_blocker(None));
    }

    #[test]
    fn publication_recovery_requires_exact_attempt_and_head() {
        let mut execution =
            ValidationExecution::new("p".into(), "w".into(), "/tmp".into(), "t".into(), None);
        execution.step = ValidationStep::CreatePr;
        execution.head_commit = Some("head".into());
        let identity = engine::begin_attempt(&mut execution).unwrap();
        execution.effects.push(ExternalEffect {
            id: format!("create-pr:{}", identity.attempt_id),
            kind: "create_pr".into(),
            intended_commit: "head".into(),
            confirmed: false,
        });
        assert!(pending_pr_publication(&execution));
        execution.effects[0].intended_commit = "foreign".into();
        assert!(!pending_pr_publication(&execution));
        execution.effects[0].intended_commit = "head".into();
        execution.active_attempt = None;
        assert!(!pending_pr_publication(&execution));
    }

    #[test]
    fn acceptance_rejects_unknown_or_waiting_preview_even_with_equal_versions() {
        let mut execution =
            ValidationExecution::new("p".into(), "w".into(), "/tmp".into(), "t".into(), Some(1));
        execution.head_commit = Some("head".into());
        let identity = StepIdentity {
            execution_id: execution.id.clone(),
            step: ValidationStep::Acceptance,
            attempt_id: "a".into(),
            input_revision: 1,
        };
        let mut version = basic_result(identity, "head".into());
        assert!(assert_acceptance_version(&execution, &version).is_err());
        execution.deployed_commit = Some("deploy".into());
        version.deployed_commit = Some("deploy".into());
        version.outcome = StepOutcome::Waiting;
        assert!(assert_acceptance_version(&execution, &version).is_err());
        version.outcome = StepOutcome::Passed;
        assert!(assert_acceptance_version(&execution, &version).is_ok());
        version.deployed_commit = Some("other".into());
        assert!(assert_acceptance_version(&execution, &version).is_err());
    }
    #[test]
    fn agent_cannot_replace_backend_freshness_or_ci() {
        let identity = StepIdentity {
            execution_id: "e".into(),
            step: ValidationStep::Acceptance,
            attempt_id: "a".into(),
            input_revision: 1,
        };
        let mut result = basic_result(identity, "head".into());
        assert!(reject_reserved_agent_fields(&result).is_ok());
        result.deployed_commit = Some("fake".into());
        assert!(reject_reserved_agent_fields(&result).is_err());
        result.deployed_commit = None;
        result.requirements.push(Requirement {
            id: "ci-head".into(),
            label: "CI".into(),
            mandatory: true,
            status: RequirementStatus::NotApplicable,
            evidence_ids: vec![],
            justification: Some("ignore CI".into()),
        });
        assert!(reject_reserved_agent_fields(&result).is_err());
    }
}

fn add_ci_proof(result: &mut StepResult, pr: u32) {
    result.evidence.push(Evidence {
        id: "ci-head".into(),
        label: "CI verte sur le head exact".into(),
        kind: "backend-ci".into(),
        value: format!("PR {pr} — {} — SUCCESS", result.commit),
        commit: result.commit.clone(),
        stale: false,
    });
    result.requirements.push(Requirement {
        id: "ci-head".into(),
        label: "CI du commit validé".into(),
        mandatory: true,
        status: RequirementStatus::Passed,
        evidence_ids: vec!["ci-head".into()],
        justification: None,
    });
}

async fn assert_pr_branch(app: &AppHandle, execution: &ValidationExecution) -> Result<(), String> {
    if has_drive_fixture(app) {
        return Ok(());
    }
    let path = execution.repository_path.clone();
    let expected = execution
        .original_branch
        .clone()
        .ok_or("Branche originale manquante")?;
    let pr = execution.pr_number.ok_or("PR manquante")?;
    let gh = crate::gh_cli::config::resolve_gh_binary(app);
    let branch = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let output = crate::platform::silent_command(&gh)
            .args(["pr", "view", &pr.to_string(), "--json", "headRefName"])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Branche distante PR non confirmée ; push refusé".into());
        }
        let value: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
        value
            .get("headRefName")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .ok_or_else(|| "headRefName PR absent".into())
    })
    .await
    .map_err(|e| e.to_string())??;
    if branch != expected {
        return Err(
            "La branche source de la PR ne correspond pas à la branche initiale ; push refusé"
                .into(),
        );
    }
    Ok(())
}
