//! Deterministic transitions: an agent's score never selects the next step.
use super::validation_types::*;

#[cfg(test)]
mod tests {
    use super::*;
    fn execution() -> ValidationExecution {
        ValidationExecution::new("p".into(), "w".into(), "/tmp".into(), "t".into(), Some(1))
    }
    #[test]
    fn unpublished_execution_implements_reviews_and_creates_pr_before_ci() {
        let mut e =
            ValidationExecution::new("p".into(), "w".into(), "/tmp".into(), "t".into(), None);
        assert_eq!(e.step, ValidationStep::Implementation);
        complete_step(&mut e, StepOutcome::Passed);
        assert_eq!(e.step, ValidationStep::Review);
        complete_step(&mut e, StepOutcome::Passed);
        assert_eq!(e.step, ValidationStep::GitSync);
        complete_step(&mut e, StepOutcome::Passed);
        assert_eq!(e.step, ValidationStep::CreatePr);
        e.pr_number = Some(3);
        complete_step(&mut e, StepOutcome::Passed);
        assert_eq!(e.step, ValidationStep::Ci);
        assert!(!is_ready(&e));
    }
    #[test]
    fn implementation_commit_invalidates_existing_proofs() {
        let mut e = ready_fixture();
        e.pr_number = None;
        e.step = ValidationStep::Implementation;
        let identity = begin_attempt(&mut e).unwrap();
        apply_result(
            &mut e,
            StepResult {
                identity,
                outcome: StepOutcome::Passed,
                commit: "implemented".into(),
                requirements: vec![],
                defects: vec![],
                evidence: vec![],
                message: None,
                deployed_commit: None,
            },
        )
        .unwrap();
        assert_eq!(e.step, ValidationStep::Review);
        assert!(e.evidence.iter().all(|proof| proof.stale));
        assert!(e.deployed_commit.is_none());
        assert!(e.acceptance_evidence_ids.is_empty());
    }
    #[test]
    fn publication_requires_confirmed_pr_identity_even_with_complete_evidence() {
        let mut e = ready_fixture();
        e.pr_number = None;
        assert!(!is_ready(&e));
        e.step = ValidationStep::CreatePr;
        let identity = begin_attempt(&mut e).unwrap();
        assert!(apply_result(
            &mut e,
            StepResult {
                identity,
                outcome: StepOutcome::Passed,
                commit: "abc".into(),
                requirements: vec![],
                defects: vec![],
                evidence: vec![],
                message: None,
                deployed_commit: None
            }
        )
        .is_err());
        assert_eq!(e.step, ValidationStep::CreatePr);
    }
    #[test]
    fn failed_implementation_never_becomes_ready() {
        let mut e =
            ValidationExecution::new("p".into(), "w".into(), "/tmp".into(), "t".into(), None);
        complete_step(&mut e, StepOutcome::Failed);
        assert_eq!(e.status, ValidationStatus::Failed);
        assert_eq!(e.step, ValidationStep::Implementation);
    }
    #[test]
    fn old_execution_defaults_publication_base_without_changing_review() {
        let mut json = serde_json::to_value(execution()).unwrap();
        json.as_object_mut()
            .unwrap()
            .remove("publication_base_branch");
        json.as_object_mut()
            .unwrap()
            .remove("publication_remote_identity");
        let migrated: ValidationExecution = serde_json::from_value(json).unwrap();
        assert_eq!(migrated.publication_base_branch, None);
        assert_eq!(migrated.publication_remote_identity, None);
        assert_eq!(migrated.step, ValidationStep::Review);
    }
    fn ready_fixture() -> ValidationExecution {
        let mut e = execution();
        e.head_commit = Some("abc".into());
        e.deployed_commit = Some("def".into());
        e.requirements.push(Requirement {
            id: "ticket-ac".into(),
            label: "Persistence tested".into(),
            mandatory: true,
            status: RequirementStatus::Passed,
            evidence_ids: vec!["acceptance".into()],
            justification: None,
        });
        for (id, kind) in [
            ("acceptance", "test"),
            ("ci-head", "backend-ci"),
            ("preview-version", "git-ancestry"),
        ] {
            e.evidence.push(Evidence {
                id: id.into(),
                label: id.into(),
                kind: kind.into(),
                value: "Verified".into(),
                commit: "abc".into(),
                stale: false,
            });
        }
        e.acceptance_evidence_ids = vec!["acceptance".into()];
        e
    }
    fn complete_step(e: &mut ValidationExecution, outcome: StepOutcome) {
        let commit = e.head_commit.clone().unwrap_or_else(|| "abc".into());
        let identity = begin_attempt(e).unwrap();
        apply_result(
            e,
            StepResult {
                identity,
                outcome,
                commit,
                requirements: vec![],
                defects: vec![],
                evidence: vec![],
                message: None,
                deployed_commit: None,
            },
        )
        .unwrap();
    }
    fn failed_acceptance_fixture() -> ValidationExecution {
        let mut e = ready_fixture();
        e.step = ValidationStep::Acceptance;
        e.requirements[0].status = RequirementStatus::Failed;
        e.requirements[0].justification = Some("Save then reload loses the value".into());
        e
    }
    #[test]
    fn passed_acceptance_with_failed_mandatory_criterion_returns_to_correction() {
        let mut e = failed_acceptance_fixture();
        complete_step(&mut e, StepOutcome::Passed);
        assert_eq!(e.step, ValidationStep::Correction);
        assert_eq!(e.status, ValidationStatus::Pending);
        assert_eq!(e.requirements[0].id, "ticket-ac");
        assert_eq!(e.requirements[0].status, RequirementStatus::Failed);
        assert_eq!(e.correction_cycles, 0);
    }
    #[test]
    fn failed_acceptance_with_functional_failure_returns_to_correction() {
        for with_defect in [false, true] {
            let mut e = failed_acceptance_fixture();
            if with_defect {
                e.requirements[0].status = RequirementStatus::Passed;
                e.defects.push(Defect {
                    id: "save-loss".into(),
                    description: "Save then reload loses value".into(),
                    mandatory: true,
                    resolved: false,
                    evidence_ids: vec!["acceptance".into()],
                });
            }
            complete_step(&mut e, StepOutcome::Failed);
            assert_eq!(e.step, ValidationStep::Correction);
            assert_eq!(e.status, ValidationStatus::Pending);
        }
    }
    #[test]
    fn review_cannot_ignore_failed_criterion_without_defect() {
        let mut e = failed_acceptance_fixture();
        e.step = ValidationStep::Review;
        complete_step(&mut e, StepOutcome::Passed);
        assert_eq!(e.step, ValidationStep::Correction);
        assert_eq!(e.status, ValidationStatus::Pending);
    }
    #[test]
    fn functional_acceptance_failures_preserve_global_correction_limits() {
        for (cycles, no_progress) in [(3, 0), (1, 2)] {
            let mut e = failed_acceptance_fixture();
            e.correction_cycles = cycles;
            e.no_progress_cycles = no_progress;
            complete_step(&mut e, StepOutcome::Failed);
            assert_eq!(e.status, ValidationStatus::Blocked);
            assert_eq!(e.correction_cycles, cycles);
            assert_eq!(e.no_progress_cycles, no_progress);
        }
    }
    #[test]
    fn functional_criterion_does_not_override_access_blocker_or_external_wait() {
        for (outcome, status) in [
            (StepOutcome::Blocked, ValidationStatus::Blocked),
            (StepOutcome::Waiting, ValidationStatus::Waiting),
        ] {
            let mut e = failed_acceptance_fixture();
            complete_step(&mut e, outcome);
            assert_eq!(e.step, ValidationStep::Acceptance);
            assert_eq!(e.status, status);
        }
    }
    #[test]
    fn missing_obsolete_or_unverified_proofs_do_not_trigger_blind_correction() {
        for unverified in [false, true] {
            let mut e = ready_fixture();
            e.step = ValidationStep::Acceptance;
            if unverified {
                e.requirements[0].status = RequirementStatus::Unverified;
            } else {
                e.evidence[0].stale = true;
            }
            complete_step(&mut e, StepOutcome::Passed);
            assert_eq!(e.step, ValidationStep::Acceptance);
            assert_eq!(e.status, ValidationStatus::Blocked);
            assert_eq!(e.correction_cycles, 0);
        }
        let mut e = ready_fixture();
        e.step = ValidationStep::Acceptance;
        complete_step(&mut e, StepOutcome::Failed);
        assert_eq!(e.status, ValidationStatus::Failed);
        assert_eq!(e.step, ValidationStep::Acceptance);
    }
    #[test]
    fn corrected_acceptance_returns_through_review_git_ci_preview_to_acceptance() {
        let mut e = failed_acceptance_fixture();
        e.correction_cycles = 2;
        e.defects.push(Defect {
            id: "save-loss".into(),
            description: "Save then reload loses value".into(),
            mandatory: true,
            resolved: false,
            evidence_ids: vec!["acceptance".into()],
        });
        complete_step(&mut e, StepOutcome::Failed);
        assert_eq!(e.step, ValidationStep::Correction);
        let identity = begin_attempt(&mut e).unwrap();
        apply_result(
            &mut e,
            StepResult {
                identity,
                outcome: StepOutcome::Passed,
                commit: "corrected-head".into(),
                requirements: vec![],
                defects: vec![],
                evidence: vec![],
                message: None,
                deployed_commit: None,
            },
        )
        .unwrap();
        assert_eq!(e.step, ValidationStep::Review);
        assert_eq!(e.correction_cycles, 3);
        assert!(e.evidence.iter().all(|proof| proof.stale));
        assert!(e.acceptance_evidence_ids.is_empty());
        assert!(e.deployed_commit.is_none());
        // Independent review supplies new proof for the exact corrected commit.
        let identity = begin_attempt(&mut e).unwrap();
        let mut requirement = e.requirements[0].clone();
        requirement.status = RequirementStatus::Passed;
        requirement.evidence_ids = vec!["regression-test".into()];
        let mut defect = e.defects[0].clone();
        defect.resolved = true;
        defect.evidence_ids = vec!["regression-test".into()];
        let proof = |id: &str, kind: &str| Evidence {
            id: id.into(),
            label: id.into(),
            kind: kind.into(),
            value: "Verified".into(),
            commit: "corrected-head".into(),
            stale: false,
        };
        apply_result(
            &mut e,
            StepResult {
                identity,
                outcome: StepOutcome::Passed,
                commit: "corrected-head".into(),
                requirements: vec![requirement],
                defects: vec![defect],
                evidence: vec![proof("regression-test", "test")],
                message: None,
                deployed_commit: None,
            },
        )
        .unwrap();
        assert_eq!(e.step, ValidationStep::GitSync);
        assert_eq!(e.no_progress_cycles, 0);
        complete_step(&mut e, StepOutcome::Passed);
        assert_eq!(e.step, ValidationStep::Ci);
        let identity = begin_attempt(&mut e).unwrap();
        apply_result(
            &mut e,
            StepResult {
                identity,
                outcome: StepOutcome::Passed,
                commit: "corrected-head".into(),
                requirements: vec![],
                defects: vec![],
                evidence: vec![proof("ci-head", "backend-ci")],
                message: None,
                deployed_commit: None,
            },
        )
        .unwrap();
        assert_eq!(e.step, ValidationStep::Preview);
        let identity = begin_attempt(&mut e).unwrap();
        apply_result(
            &mut e,
            StepResult {
                identity,
                outcome: StepOutcome::Passed,
                commit: "corrected-head".into(),
                requirements: vec![],
                defects: vec![],
                evidence: vec![proof("preview-version", "git-ancestry")],
                message: None,
                deployed_commit: Some("corrected-deployed".into()),
            },
        )
        .unwrap();
        assert_eq!(e.step, ValidationStep::Acceptance);
        assert_eq!(e.correction_cycles, 3);
        assert!(!is_ready(&e));
        let identity = begin_attempt(&mut e).unwrap();
        let mut requirement = e.requirements[0].clone();
        requirement.evidence_ids = vec!["acceptance-retest".into()];
        apply_result(
            &mut e,
            StepResult {
                identity,
                outcome: StepOutcome::Passed,
                commit: "corrected-head".into(),
                requirements: vec![requirement],
                defects: vec![],
                evidence: vec![proof("acceptance-retest", "acceptance")],
                message: None,
                deployed_commit: None,
            },
        )
        .unwrap();
        assert_eq!(e.status, ValidationStatus::Ready);
        assert_eq!(e.step, ValidationStep::Complete);
        assert_eq!(e.defects[0].id, "save-loss");
    }
    #[test]
    fn unverified_review_continues_to_recipe_but_never_marks_ready() {
        let mut e = ready_fixture();
        e.step = ValidationStep::Review;
        e.requirements[0].status = RequirementStatus::Unverified;
        complete_step(&mut e, StepOutcome::Passed);
        assert_eq!(e.step, ValidationStep::GitSync);
        assert!(!is_ready(&e));
    }
    #[test]
    fn optional_functional_failure_does_not_start_correction() {
        let mut e = ready_fixture();
        e.step = ValidationStep::Acceptance;
        let mut optional = e.requirements[0].clone();
        optional.id = "optional".into();
        optional.mandatory = false;
        optional.status = RequirementStatus::Failed;
        e.requirements.push(optional);
        complete_step(&mut e, StepOutcome::Passed);
        assert_eq!(e.status, ValidationStatus::Ready);
        assert_eq!(e.correction_cycles, 0);
    }
    #[test]
    fn readiness_requires_backend_ci_and_preview_proof() {
        let mut e = ready_fixture();
        assert!(is_ready(&e));
        e.evidence.retain(|proof| proof.id != "ci-head");
        assert!(!is_ready(&e));
        e.evidence.push(Evidence {
            id: "ci-head".into(),
            label: "Agent says CI passed".into(),
            kind: "test".into(),
            value: "Passed".into(),
            commit: "abc".into(),
            stale: false,
        });
        assert!(!is_ready(&e));
    }
    #[test]
    fn obsolete_system_proof_cannot_be_replaced_by_not_applicable() {
        let mut e = ready_fixture();
        e.evidence
            .iter_mut()
            .find(|p| p.id == "ci-head")
            .unwrap()
            .stale = true;
        e.requirements.push(Requirement {
            id: "ci-head".into(),
            label: "CI".into(),
            mandatory: true,
            status: RequirementStatus::NotApplicable,
            evidence_ids: vec![],
            justification: Some("Agent claims unnecessary".into()),
        });
        assert!(!is_ready(&e));
    }
    #[test]
    fn ready_requires_current_defect_proof_and_confirmed_effects() {
        let mut e = ready_fixture();
        e.defects.push(Defect {
            id: "d".into(),
            description: "Bug".into(),
            mandatory: true,
            resolved: true,
            evidence_ids: vec!["missing".into()],
        });
        assert!(!is_ready(&e));
        e.defects[0].evidence_ids = vec!["acceptance".into()];
        assert!(is_ready(&e));
        e.effects.push(ExternalEffect {
            id: "push".into(),
            kind: "push".into(),
            intended_commit: "abc".into(),
            confirmed: false,
        });
        assert!(!is_ready(&e));
        e.effects[0].confirmed = true;
        assert!(is_ready(&e));
    }
    #[test]
    fn review_proofs_alone_never_replace_acceptance() {
        let mut e = ready_fixture();
        e.acceptance_evidence_ids.clear();
        assert!(!is_ready(&e));
    }
    #[test]
    fn every_mandatory_business_criterion_requires_acceptance_proof() {
        let mut e = ready_fixture();
        e.evidence.push(Evidence {
            id: "review-only".into(),
            label: "Review".into(),
            kind: "test".into(),
            value: "Reviewed".into(),
            commit: "abc".into(),
            stale: false,
        });
        e.requirements.push(Requirement {
            id: "second-ac".into(),
            label: "Second criterion".into(),
            mandatory: true,
            status: RequirementStatus::Passed,
            evidence_ids: vec!["review-only".into()],
            justification: None,
        });
        assert!(
            !is_ready(&e),
            "a partial recipe cannot validate the entire ticket"
        );
        e.acceptance_evidence_ids.push("review-only".into());
        assert!(is_ready(&e));
        e.requirements.push(Requirement {
            id: "ci-head".into(),
            label: "CI".into(),
            mandatory: true,
            status: RequirementStatus::Passed,
            evidence_ids: vec!["ci-head".into()],
            justification: None,
        });
        assert!(
            is_ready(&e),
            "backend CI is not a business acceptance criterion"
        );
    }
    #[test]
    fn no_applicable_mandatory_criterion_is_not_ready() {
        let mut e = ready_fixture();
        e.requirements[0].status = RequirementStatus::NotApplicable;
        e.requirements[0].justification = Some("Not relevant".into());
        assert!(!is_ready(&e));
    }
    #[test]
    fn stale_results_do_not_mutate_state() {
        let mut e = execution();
        let identity = begin_attempt(&mut e).unwrap();
        let revision = e.revision;
        let mut result = StepResult {
            identity,
            outcome: StepOutcome::Passed,
            commit: "abc".into(),
            requirements: vec![],
            defects: vec![],
            evidence: vec![],
            message: None,
            deployed_commit: None,
        };
        result.identity.input_revision += 1;
        assert!(apply_result(&mut e, result).is_err());
        assert_eq!(e.revision, revision);
    }
    #[test]
    fn missing_evidence_is_not_ready() {
        let mut e = execution();
        e.step = ValidationStep::Acceptance;
        e.head_commit = Some("abc".into());
        let identity = begin_attempt(&mut e).unwrap();
        let result = StepResult {
            identity,
            outcome: StepOutcome::Passed,
            commit: "abc".into(),
            requirements: vec![Requirement {
                id: "r".into(),
                label: "r".into(),
                mandatory: true,
                status: RequirementStatus::Passed,
                evidence_ids: vec![],
                justification: None,
            }],
            defects: vec![],
            evidence: vec![],
            message: None,
            deployed_commit: None,
        };
        apply_result(&mut e, result).unwrap();
        assert_eq!(e.status, ValidationStatus::Blocked);
    }
    #[test]
    fn two_failed_corrections_stop_without_score_progress() {
        let mut e = execution();
        e.step = ValidationStep::Correction;
        for _ in 0..2 {
            let identity = begin_attempt(&mut e).unwrap();
            apply_result(
                &mut e,
                StepResult {
                    identity,
                    outcome: StepOutcome::CorrectionRequired,
                    commit: "abc".into(),
                    requirements: vec![],
                    defects: vec![],
                    evidence: vec![],
                    message: None,
                    deployed_commit: None,
                },
            )
            .unwrap();
        }
        assert_eq!(e.status, ValidationStatus::Blocked);
        assert_eq!(e.correction_cycles, 2);
        assert_eq!(e.no_progress_cycles, 2);
        assert!(begin_attempt(&mut e).is_err());
    }
    #[test]
    fn mandatory_criterion_cannot_be_downgraded() {
        let mut e = execution();
        let criterion = Requirement {
            id: "r".into(),
            label: "r".into(),
            mandatory: true,
            status: RequirementStatus::Unverified,
            evidence_ids: vec![],
            justification: None,
        };
        e.requirements.push(criterion.clone());
        let identity = begin_attempt(&mut e).unwrap();
        let mut optional = criterion;
        optional.mandatory = false;
        assert!(apply_result(
            &mut e,
            StepResult {
                identity,
                outcome: StepOutcome::Passed,
                commit: "abc".into(),
                requirements: vec![optional],
                defects: vec![],
                evidence: vec![],
                message: None,
                deployed_commit: None
            }
        )
        .is_err());
        assert!(e.requirements[0].mandatory);
    }
    #[test]
    fn cycle_ceiling_does_not_prevent_third_cycle_ci() {
        let mut e = execution();
        e.correction_cycles = 3;
        e.step = ValidationStep::GitSync;
        assert!(begin_attempt(&mut e).is_ok());
        e.active_attempt = None;
        e.step = ValidationStep::Correction;
        assert!(begin_attempt(&mut e).is_err());
    }
}

pub fn record(execution: &mut ValidationExecution, message: impl Into<String>) {
    execution.revision += 1;
    execution.updated_at = chrono::Utc::now().to_rfc3339();
    execution.transitions.push(Transition {
        revision: execution.revision,
        step: execution.step,
        status: execution.status,
        message: message.into(),
        timestamp: execution.updated_at.clone(),
    });
}
pub fn block(execution: &mut ValidationExecution, reason: impl Into<String>) {
    let reason = reason.into();
    execution.status = ValidationStatus::Blocked;
    execution.blocker = Some(reason.clone());
    record(execution, reason);
}
pub fn pause(execution: &mut ValidationExecution) {
    execution.paused = true;
    record(
        execution,
        "Pause requested; active operation must be reconciled, not cancelled",
    );
}
pub fn begin_attempt(execution: &mut ValidationExecution) -> Result<StepIdentity, String> {
    if execution.paused
        || execution.active_attempt.is_some()
        || execution.status == ValidationStatus::Ready
    {
        return Err("Execution paused, complete, or already owns an active attempt".into());
    }
    if execution.step == ValidationStep::Correction
        && (execution.correction_cycles >= 3 || execution.no_progress_cycles >= 2)
    {
        return Err("Correction limit reached".into());
    }
    execution.status = ValidationStatus::Running;
    execution.blocker = None;
    record(execution, "Step started");
    let identity = StepIdentity {
        execution_id: execution.id.clone(),
        step: execution.step,
        attempt_id: uuid::Uuid::new_v4().to_string(),
        input_revision: execution.revision,
    };
    execution.active_attempt = Some(identity.clone());
    Ok(identity)
}
fn proven_ids(execution: &ValidationExecution) -> Vec<String> {
    let valid = |ids: &[String]| {
        !ids.is_empty()
            && ids.iter().all(|id| {
                execution.evidence.iter().any(|e| {
                    e.id == *id && !e.stale && Some(&e.commit) == execution.head_commit.as_ref()
                })
            })
    };
    execution
        .requirements
        .iter()
        .filter(|r| r.mandatory && r.status == RequirementStatus::Passed && valid(&r.evidence_ids))
        .map(|r| format!("requirement:{}", r.id))
        .chain(
            execution
                .defects
                .iter()
                .filter(|d| d.mandatory && d.resolved && valid(&d.evidence_ids))
                .map(|d| format!("defect:{}", d.id)),
        )
        .collect()
}
fn has_system_proof(execution: &ValidationExecution, id: &str, kind: &str) -> bool {
    execution.evidence.iter().any(|e| {
        e.id == id
            && e.kind == kind
            && !e.stale
            && Some(&e.commit) == execution.head_commit.as_ref()
            && !e.value.trim().is_empty()
    })
}

pub fn is_ready(execution: &ValidationExecution) -> bool {
    execution.pr_number.is_some()
        && has_system_proof(execution, "ci-head", "backend-ci")
        && has_system_proof(execution, "preview-version", "git-ancestry")
        && execution
            .requirements
            .iter()
            .any(|r| r.mandatory && r.status == RequirementStatus::Passed)
        && execution.requirements.iter().any(|r| {
            r.mandatory
                && r.status == RequirementStatus::Passed
                && r.evidence_ids
                    .iter()
                    .any(|id| execution.acceptance_evidence_ids.contains(id))
        })
        && execution.head_commit.is_some()
        && execution.deployed_commit.is_some()
        && execution.requirements.iter().all(|r| {
            !r.mandatory
                || match r.status {
                    RequirementStatus::Passed => {
                        !r.evidence_ids.is_empty()
                            && (r.id == "ci-head"
                                || r.evidence_ids
                                    .iter()
                                    .any(|id| execution.acceptance_evidence_ids.contains(id)))
                            && r.evidence_ids.iter().all(|id| {
                                execution.evidence.iter().any(|e| {
                                    e.id == *id
                                        && !e.stale
                                        && Some(&e.commit) == execution.head_commit.as_ref()
                                })
                            })
                    }
                    RequirementStatus::NotApplicable => r
                        .justification
                        .as_ref()
                        .is_some_and(|j| !j.trim().is_empty()),
                    _ => false,
                }
        })
        && execution.defects.iter().all(|d| {
            !d.mandatory
                || (d.resolved
                    && !d.evidence_ids.is_empty()
                    && d.evidence_ids.iter().all(|id| {
                        execution.evidence.iter().any(|e| {
                            e.id == *id
                                && !e.stale
                                && Some(&e.commit) == execution.head_commit.as_ref()
                        })
                    }))
        })
        && execution.effects.iter().all(|effect| effect.confirmed)
}
/// Validate first, then mutate. Late/duplicate/malformed results cannot advance state.
pub fn apply_result(execution: &mut ValidationExecution, result: StepResult) -> Result<(), String> {
    if execution.active_attempt.as_ref() != Some(&result.identity)
        || result.identity.execution_id != execution.id
        || result.identity.step != execution.step
    {
        return Err("Stale or duplicate step result".into());
    }
    if result.requirements.iter().any(|r| {
        execution
            .requirements
            .iter()
            .any(|old| old.id == r.id && old.mandatory && !r.mandatory)
    }) || result.defects.iter().any(|d| {
        execution
            .defects
            .iter()
            .any(|old| old.id == d.id && old.mandatory && !d.mandatory)
    }) {
        return Err("Mandatory obligations cannot be downgraded by an agent".into());
    }
    if result.identity.step == ValidationStep::CreatePr
        && result.outcome == StepOutcome::Passed
        && execution.pr_number.is_none()
    {
        return Err("PR creation has no confirmed PR identity".into());
    }
    if result.commit.trim().is_empty() {
        return Err("Result has no tested commit".into());
    }
    for ids in [
        &result
            .requirements
            .iter()
            .map(|r| &r.id)
            .collect::<Vec<_>>(),
        &result.defects.iter().map(|d| &d.id).collect::<Vec<_>>(),
        &result.evidence.iter().map(|e| &e.id).collect::<Vec<_>>(),
    ] {
        let mut seen = std::collections::HashSet::new();
        if ids
            .iter()
            .any(|id| id.trim().is_empty() || !seen.insert(*id))
        {
            return Err("Result contains empty or duplicate stable identifiers".into());
        }
    }
    if result.evidence.iter().any(|e| e.commit != result.commit) {
        return Err("Evidence belongs to another commit".into());
    }
    if !matches!(
        result.identity.step,
        ValidationStep::Correction | ValidationStep::Implementation
    ) && execution
        .head_commit
        .as_ref()
        .is_some_and(|head| head != &result.commit)
    {
        execution.active_attempt = None;
        execution.active_session_id = None;
        block(
            execution,
            "Code changed during validation; results must be regenerated",
        );
        return Ok(());
    }
    if execution
        .head_commit
        .as_ref()
        .is_some_and(|head| head != &result.commit)
    {
        execution.evidence.iter_mut().for_each(|e| e.stale = true);
        execution
            .requirements
            .iter_mut()
            .for_each(|r| r.status = RequirementStatus::Unverified);
        execution.deployed_commit = None;
        execution.acceptance_evidence_ids.clear();
    }
    execution.head_commit = Some(result.commit.clone());
    for evidence in result.evidence {
        execution
            .acceptance_evidence_ids
            .retain(|id| id != &evidence.id);
        if result.identity.step == ValidationStep::Acceptance {
            execution.acceptance_evidence_ids.push(evidence.id.clone());
        }
        if let Some(old) = execution.evidence.iter_mut().find(|e| e.id == evidence.id) {
            *old = evidence;
        } else {
            execution.evidence.push(evidence);
        }
    }
    for requirement in result.requirements {
        if let Some(old) = execution
            .requirements
            .iter_mut()
            .find(|r| r.id == requirement.id)
        {
            *old = requirement;
        } else {
            execution.requirements.push(requirement);
        }
    }
    for defect in result.defects {
        if let Some(old) = execution.defects.iter_mut().find(|d| d.id == defect.id) {
            *old = defect;
        } else {
            execution.defects.push(defect);
        }
    }
    execution.active_attempt = None;
    execution.active_session_id = None;
    if let Some(commit) = result.deployed_commit {
        execution.deployed_commit = Some(commit);
    }
    if execution.step == ValidationStep::Correction
        && matches!(
            result.outcome,
            StepOutcome::Passed | StepOutcome::CorrectionRequired
        )
    {
        execution.correction_cycles += 1;
        execution.correction_pending_verification = result.outcome == StepOutcome::Passed;
        if result.outcome == StepOutcome::CorrectionRequired {
            execution.no_progress_cycles += 1;
        }
    }
    if execution.correction_pending_verification
        && matches!(
            execution.step,
            ValidationStep::Review | ValidationStep::Ci | ValidationStep::Acceptance
        )
        && result.outcome != StepOutcome::Waiting
    {
        let progress = proven_ids(execution)
            .iter()
            .any(|id| execution.progress_baseline.contains(id));
        execution.no_progress_cycles = if progress {
            0
        } else {
            execution.no_progress_cycles + 1
        };
        execution.correction_pending_verification = false;
    }
    // Use the merged obligations: omitting a previously failed criterion must not
    // erase it, and "passed" from an agent cannot override a functional failure.
    // Missing/stale evidence and Unverified are not code defects. Access blockers
    // and pending external operations take precedence over any retained defect.
    let functional_failure = execution.defects.iter().any(|d| d.mandatory && !d.resolved)
        || execution
            .requirements
            .iter()
            .any(|r| r.mandatory && r.status == RequirementStatus::Failed);
    let should_remediate = functional_failure
        && ((result.outcome == StepOutcome::Passed
            && matches!(
                result.identity.step,
                ValidationStep::Review | ValidationStep::Ci | ValidationStep::Acceptance
            ))
            || (result.outcome == StepOutcome::Failed
                && result.identity.step == ValidationStep::Acceptance));
    let outcome = if should_remediate {
        StepOutcome::CorrectionRequired
    } else {
        result.outcome
    };
    if outcome != StepOutcome::Waiting {
        execution.waiting_since = None;
    }
    match outcome {
        StepOutcome::Blocked => {
            block(
                execution,
                result
                    .message
                    .unwrap_or_else(|| "Missing decision or access".into()),
            );
            return Ok(());
        }
        StepOutcome::Failed => {
            execution.status = ValidationStatus::Failed;
            execution.blocker = result.message.clone();
        }
        StepOutcome::Waiting => {
            execution
                .waiting_since
                .get_or_insert_with(|| chrono::Utc::now().to_rfc3339());
            execution.status = ValidationStatus::Waiting;
        }
        StepOutcome::CorrectionRequired => {
            if execution.correction_cycles >= 3 || execution.no_progress_cycles >= 2 {
                block(
                    execution,
                    "Correction limit reached; manual decision required",
                );
                return Ok(());
            }
            let proven = proven_ids(execution);
            execution.progress_baseline = execution
                .requirements
                .iter()
                .filter(|r| r.mandatory)
                .map(|r| format!("requirement:{}", r.id))
                .chain(
                    execution
                        .defects
                        .iter()
                        .filter(|d| d.mandatory)
                        .map(|d| format!("defect:{}", d.id)),
                )
                .filter(|id| !proven.contains(id))
                .collect();
            execution.step = ValidationStep::Correction;
            execution.status = ValidationStatus::Pending;
        }
        StepOutcome::Passed => {
            execution.step = match execution.step {
                ValidationStep::Implementation => ValidationStep::Review,
                ValidationStep::CreatePr => ValidationStep::Ci,
                ValidationStep::Review => ValidationStep::GitSync,
                ValidationStep::Correction => ValidationStep::Review,
                ValidationStep::GitSync => {
                    if execution.pr_number.is_none() {
                        ValidationStep::CreatePr
                    } else {
                        ValidationStep::Ci
                    }
                }
                ValidationStep::Ci => ValidationStep::Preview,
                ValidationStep::Preview => ValidationStep::Acceptance,
                ValidationStep::Acceptance | ValidationStep::Complete => ValidationStep::Complete,
            };
            execution.status = ValidationStatus::Pending;
            if execution.step == ValidationStep::Complete {
                if is_ready(execution) {
                    execution.status = ValidationStatus::Ready;
                } else {
                    execution.step = ValidationStep::Acceptance;
                    block(execution, "Required evidence missing or obsolete");
                    return Ok(());
                }
            }
        }
    }
    record(
        execution,
        result
            .message
            .unwrap_or_else(|| "Step result accepted".into()),
    );
    Ok(())
}
