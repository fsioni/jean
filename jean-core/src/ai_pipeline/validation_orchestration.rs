//! Decisions shared by live command orchestration and its isolated regression harness.
use super::validation_types::*;

/// Failed and ready executions still own the worktree until explicitly superseded.
/// Never choose arbitrarily between historical conflicting owners.
pub fn canonical_execution<'a>(
    executions: &'a [ValidationExecution],
    worktree_id: &str,
) -> Result<Option<&'a ValidationExecution>, String> {
    let mut owners = executions
        .iter()
        .filter(|e| e.worktree_id == worktree_id && e.superseded_by.is_none());
    let owner = owners.next();
    if owners.next().is_some() {
        return Err("Plusieurs validations non remplacées pour ce worktree : réconciliation explicite requise".into());
    }
    Ok(owner)
}

pub fn recoverable(execution: &ValidationExecution) -> bool {
    !execution.paused
        && execution.superseded_by.is_none()
        && matches!(
            execution.status,
            ValidationStatus::Pending | ValidationStatus::Running | ValidationStatus::Waiting
        )
}

/// A worker may merge a concurrent pause, but must never undo a replacement or
/// a newer resume/result. No stale snapshot may authorize another side effect.
pub fn assert_worker_current(
    worker: &ValidationExecution,
    persisted: &ValidationExecution,
) -> Result<(), String> {
    if persisted.superseded_by.is_some() {
        return Err("Validation remplacée pendant l'étape ; snapshot obsolète refusé".into());
    }
    if persisted.active_attempt.is_some()
        && worker.active_attempt.is_some()
        && persisted.active_attempt != worker.active_attempt
    {
        return Err("Tentative modifiée pendant l'étape ; snapshot obsolète refusé".into());
    }
    Ok(())
}

/// Metadata is authoritative, not the last assistant message in a session.
/// A session is dedicated to exactly one attempt; unrelated appended runs are
/// rejected even if their output claims the expected identity.
pub fn assert_run_binding(
    execution: &ValidationExecution,
    session_id: &str,
    prompt_identity: Option<&StepIdentity>,
    run_count: usize,
    cancelled: bool,
    successful: bool,
) -> Result<(), String> {
    if execution.active_session_id.as_deref() != Some(session_id)
        || execution.active_attempt.as_ref() != prompt_identity
        || prompt_identity.is_none()
        || run_count != 1
    {
        return Err("Run/session/prompt non lié à la tentative ; résultat refusé".into());
    }
    if cancelled || !successful {
        return Err("Run annulé ou non terminé avec succès ; résultat refusé".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn execution() -> ValidationExecution {
        ValidationExecution::new(
            "p".into(),
            "w".into(),
            "/isolated".into(),
            "t".into(),
            Some(42),
        )
    }
    #[test]
    fn failed_correction_remains_canonical_and_duplicate_review_fails_closed() {
        let mut old = execution();
        old.status = ValidationStatus::Failed;
        old.step = ValidationStep::Correction;
        let mut states = vec![old.clone()];
        assert_eq!(
            canonical_execution(&states, "w").unwrap().unwrap().id,
            old.id
        );
        states.push(execution());
        assert!(canonical_execution(&states, "w").is_err());
        states[0].superseded_by = Some(states[1].id.clone());
        assert_eq!(
            canonical_execution(&states, "w").unwrap().unwrap().id,
            states[1].id
        );
    }
    #[test]
    fn recovery_never_restarts_manual_or_terminal_states() {
        let mut e = execution();
        for status in [
            ValidationStatus::Blocked,
            ValidationStatus::Failed,
            ValidationStatus::Ready,
        ] {
            e.status = status;
            assert!(!recoverable(&e));
        }
        for status in [
            ValidationStatus::Pending,
            ValidationStatus::Running,
            ValidationStatus::Waiting,
        ] {
            e.status = status;
            assert!(recoverable(&e));
            e.paused = true;
            assert!(!recoverable(&e));
            e.paused = false;
        }
    }
    #[test]
    fn stale_worker_cannot_undo_replacement() {
        let worker = execution();
        let mut persisted = worker.clone();
        persisted.superseded_by = Some(execution().id);
        assert!(assert_worker_current(&worker, &persisted).is_err());
    }
    #[test]
    fn run_binding_rejects_unrelated_prompt_extra_run_and_error() {
        let mut e = execution();
        let identity = StepIdentity {
            execution_id: e.id.clone(),
            step: e.step,
            attempt_id: "attempt".into(),
            input_revision: 1,
        };
        e.active_attempt = Some(identity.clone());
        e.record_agent_session("session".into(), &identity);
        assert!(assert_run_binding(&e, "session", Some(&identity), 1, false, true).is_ok());
        assert!(assert_run_binding(&e, "session", None, 1, false, true).is_err());
        assert!(assert_run_binding(&e, "session", Some(&identity), 2, false, true).is_err());
        assert!(assert_run_binding(&e, "session", Some(&identity), 1, false, false).is_err());
        assert!(assert_run_binding(&e, "session", Some(&identity), 1, true, true).is_err());
    }
}
