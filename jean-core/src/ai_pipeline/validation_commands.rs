//! Durable private validation jobs. Every external action starts from persisted intent.
use super::{
    validation_engine as engine, validation_steps as steps, validation_storage::ValidationStore,
    validation_types::*,
};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

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
    store(app)?.save(execution)
}

// Persist worker snapshots under the same lock as user actions. User pause and
// its journal entry win even when requested during an awaited agent call.
fn save_worker(app: &AppHandle, execution: &mut ValidationExecution) -> Result<(), String> {
    let _guard = MUTATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(latest) = store(app)?.get(&execution.id)? {
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
        results.push(refresh_ready_snapshot(&app, execution).await?);
    }
    Ok(results)
}
pub async fn get_ai_pipeline_validation(
    app: AppHandle,
    execution_id: String,
) -> Result<ValidationExecution, String> {
    refresh_ready_snapshot(&app, get(&app, &execution_id)?).await
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
    let local = tauri::async_runtime::spawn_blocking(move || -> Result<(String, bool), String> {
        Ok((
            steps::git(&path, &["rev-parse", "HEAD"])?,
            steps::git(&path, &["status", "--porcelain"])?.is_empty(),
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
    let execution = {
        let _guard = MUTATIONS
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|e| e.to_string())?;
        let storage = store(&app)?;
        let previous = storage
            .list()?
            .into_iter()
            .find(|e| e.worktree_id == worktree_id && e.is_active());
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
        execution.limitations.push("Le worktree doit rester réservé à cette validation : Jean ne peut pas distinguer les éditions utilisateur concurrentes de celles de l'agent pendant une correction.".into());
        execution.limitations.push("Les outils des agents ne sont pas techniquement confinés ; les interdictions de publication et production sont des instructions. Aucun merge automatique.".into());
        execution.head_commit = Some(steps::git(
            &execution.repository_path,
            &["rev-parse", "HEAD"],
        )?);
        if !steps::git(&execution.repository_path, &["status", "--porcelain"])?.is_empty() {
            engine::block(&mut execution, "Modifications préexistantes : attribution ambiguë. Nettoie ou sauvegarde le worktree avant de reprendre.");
        }
        if execution.pr_number.is_none() {
            engine::block(
                &mut execution,
                "Une PR existante est requise pour vérifier la CI et la preview.",
            );
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
        if execution.active_attempt.is_none() {
            if execution.step == ValidationStep::Review
                && !steps::git(&execution.repository_path, &["status", "--porcelain"])?.is_empty()
            {
                return Err("Le worktree doit être propre avant reprise de review".into());
            }
            execution.blocker = None;
        }
        execution.status = ValidationStatus::Pending;
        execution.paused = false;
        engine::record(&mut execution, "Reprise demandée");
        save(&app, &execution)?;
        execution
    };
    launch(app, execution.id.clone());
    Ok(execution)
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
                engine::block(&mut execution, error);
                let _ = save(&app, &execution);
            }
        }
        if let Ok(mut jobs) = JOBS.get_or_init(|| Mutex::new(HashSet::new())).lock() {
            jobs.remove(&id);
        }
        // A resume can race with the old worker observing pause and exiting.
        if get(&app, &id).is_ok_and(|execution| {
            !execution.paused
                && execution.superseded_by.is_none()
                && matches!(
                    execution.status,
                    ValidationStatus::Pending
                        | ValidationStatus::Running
                        | ValidationStatus::Waiting
                )
        }) {
            launch(app, id);
        }
    });
}

async fn drive(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut waits = 0;
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
        let data = crate::projects::storage::load_projects_data(app)?;
        let worktree = data
            .worktrees
            .iter()
            .find(|w| w.id == execution.worktree_id && w.project_id == execution.project_id)
            .ok_or("Worktree absent ou changé de projet")?;
        if worktree.path != execution.repository_path
            || worktree
                .pr_number
                .is_some_and(|pr| Some(pr) != execution.pr_number)
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
        let pr = execution.pr_number.ok_or("PR requise pour continuer")?;
        super::commands::verify_ai_pipeline_github_assignment(
            app.clone(),
            execution.project_id.clone(),
            pr,
        )
        .await?;
        if execution.step == ValidationStep::Review
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
                    assert_pr_branch(app, &execution).await?;
                    if !steps::git(&execution.repository_path, &["status", "--porcelain"])?
                        .is_empty()
                    {
                        return Err("Worktree modifié après review : push refusé".into());
                    }
                    let head = steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?;
                    if execution.head_commit.as_ref() != Some(&head) {
                        return Err("HEAD a changé après review".into());
                    }
                    execution.effects.push(ExternalEffect {
                        id: identity.attempt_id.clone(),
                        kind: "push".into(),
                        intended_commit: head.clone(),
                        confirmed: false,
                    });
                    save_worker(app, &mut execution)?;
                    let path = execution.repository_path.clone();
                    let sync_execution = execution.clone();
                    let head = tauri::async_runtime::spawn_blocking(move || {
                        steps::sync_git(&sync_execution)
                    })
                    .await
                    .map_err(|e| e.to_string())??;
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
                ValidationStep::Ci => ci_result(app, &mut execution, &identity).await?,
                ValidationStep::Preview => preview_result(&execution, identity.clone()).await?,
                ValidationStep::Complete => return Ok(()),
                _ => execute_agent(app, &mut execution, &identity).await?,
            }
        };
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
        if execution.step == ValidationStep::Correction && result.outcome == StepOutcome::Passed {
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
                if !intended
                    || subject != "fix: address review findings"
                    || !steps::git(&execution.repository_path, &["status", "--porcelain"])?
                        .is_empty()
                {
                    return Err("HEAD a changé sans commit de correction réconciliable ; intervention requise".into());
                }
            }
            // Commit the corrected tree before the next independent review. Do not
            // relabel the agent's old test evidence as proof of the new revision.
            if !steps::git(&execution.repository_path, &["status", "--porcelain"])?.is_empty() {
                let head_before = steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?;
                if execution.head_commit.as_ref() != Some(&head_before) {
                    return Err("HEAD changé pendant correction ; commit refusé".into());
                }
                let effect_id = format!("commit:{}", identity.attempt_id);
                if !execution.effects.iter().any(|e| e.id == effect_id) {
                    execution.effects.push(ExternalEffect {
                        id: effect_id,
                        kind: "commit".into(),
                        intended_commit: head_before,
                        confirmed: false,
                    });
                }
                save_worker(app, &mut execution)?;
                steps::git(&execution.repository_path, &["add", "--all"])?;
                steps::git(
                    &execution.repository_path,
                    &["commit", "-m", "fix: address review findings"],
                )?;
            }
            result.commit = steps::git(&execution.repository_path, &["rev-parse", "HEAD"])?;
            execution
                .effects
                .iter_mut()
                .filter(|e| e.kind == "commit")
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
        save_worker(app, &mut execution)?;
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
    if execution.step == ValidationStep::Acceptance {
        assert_remote_head(app, execution).await?;
        let version = preview_result(execution, identity.clone()).await?;
        assert_acceptance_version(execution, &version)?;
    }
    let session = crate::chat::create_session(
        app.clone(),
        execution.worktree_id.clone(),
        execution.repository_path.clone(),
        Some(format!("Validation privée · {:?}", execution.step)),
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .await?;
    execution.active_session_id = Some(session.id.clone());
    save_worker(app, execution)?;
    send_existing_session(app, execution, identity, session.id).await
}
async fn send_existing_session(
    app: &AppHandle,
    execution: &ValidationExecution,
    identity: &StepIdentity,
    session_id: String,
) -> Result<StepResult, String> {
    let prompt = steps::prompt(execution, identity)?;
    let message = crate::chat::send_chat_message(
        app.clone(),
        session_id,
        execution.worktree_id.clone(),
        execution.repository_path.clone(),
        prompt,
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
    if message.cancelled {
        return Err("Étape agent annulée ; réconciliation requise".into());
    }
    let result = steps::parse_agent_result(&message.content, identity)?;
    reject_reserved_agent_fields(&result)?;
    Ok(result)
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
    if crate::chat::registry::is_session_actively_managed(&session_id) {
        return Err("Le run de cette étape est toujours actif. Aucun second prompt envoyé ; réessaie après sa fin.".into());
    }
    let metadata = crate::chat::storage::load_metadata(app, &session_id)?;
    if metadata
        .as_ref()
        .is_none_or(|metadata| metadata.runs.is_empty())
    {
        let session = crate::chat::get_session(
            app.clone(),
            execution.worktree_id.clone(),
            execution.repository_path.clone(),
            session_id.clone(),
            None,
        )
        .await?;
        if session
            .messages
            .iter()
            .any(|message| matches!(message.role, crate::chat::types::MessageRole::User))
        {
            return Err(
                "Session sans run mais contenant un prompt : réconciliation requise avant envoi"
                    .into(),
            );
        }
        return send_existing_session(app, execution, identity, session_id).await;
    }
    let metadata = metadata.ok_or("Manifest du run introuvable")?;
    let run = metadata.runs.last().ok_or("Run manquant")?;
    if run.status != crate::chat::types::RunStatus::Completed
        && !crate::chat::run_log::jsonl_has_result_line(app, &session_id, &run.run_id)
    {
        return Err(
            "Run non terminal : aucune sortie finale confirmée, aucun prompt dupliqué".into(),
        );
    }
    let session = crate::chat::get_session(
        app.clone(),
        execution.worktree_id.clone(),
        execution.repository_path.clone(),
        session_id,
        None,
    )
    .await?;
    let message = session
        .messages
        .iter()
        .rev()
        .find(|m| matches!(m.role, crate::chat::types::MessageRole::Assistant))
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
