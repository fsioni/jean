//! Offline laboratory: real state machine/storage/parser, explicitly scripted services.
//! This module has no project selector, app handle, credentials or live service calls.
use super::{
    validation_engine, validation_steps::parse_agent_result, validation_storage::ValidationStore,
    validation_types::*,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationLabCheck {
    pub label: String,
    pub passed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationLabTransition {
    pub step: String,
    pub status: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationLabScenario {
    pub id: String,
    pub label: String,
    pub passed: bool,
    pub summary: String,
    pub checks: Vec<ValidationLabCheck>,
    pub transitions: Vec<ValidationLabTransition>,
    pub execution: Option<ValidationExecution>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationLabReport {
    pub scenarios: Vec<ValidationLabScenario>,
    pub passed_count: usize,
    pub total_count: usize,
    pub isolated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_offline_scenarios_pass_and_leave_no_state() {
        let (report, removed_root) = run_all_with_cleanup().unwrap();
        assert!(report.isolated);
        assert!(!removed_root.exists());
        assert_eq!(report.total_count, 12);
        assert_eq!(report.passed_count, report.total_count, "{report:#?}");
        for scenario in &report.scenarios {
            assert!(scenario.passed);
            assert!(!scenario.checks.is_empty());
            assert!(scenario
                .execution
                .as_ref()
                .is_some_and(|e| !Path::new(&e.repository_path).exists()));
        }
    }
    #[test]
    fn acceptance_loop_reports_new_head_and_full_return_path() {
        let report = run_all_with_cleanup().unwrap().0;
        let scenario = report
            .scenarios
            .iter()
            .find(|s| s.id == "acceptance-correction")
            .unwrap();
        let e = scenario.execution.as_ref().unwrap();
        assert_eq!(e.head_commit.as_deref(), Some(CORRECTED_HEAD));
        assert_eq!(e.status, ValidationStatus::Ready);
        let expected = [
            "correction",
            "review",
            "git_sync",
            "ci",
            "preview",
            "acceptance",
            "complete",
        ];
        let mut cursor = 0;
        for transition in &scenario.transitions {
            if cursor < expected.len() && transition.step == expected[cursor] {
                cursor += 1;
            }
        }
        assert_eq!(cursor, expected.len());
        assert!(scenario.summary.contains("simul"));
    }
    #[test]
    fn malformed_script_is_not_salvaged_into_a_passing_result() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = LabContext::new(dir.path()).unwrap();
        let identity = validation_engine::begin_attempt(&mut c.execution).unwrap();
        assert!(parse_agent_result("score 99; everything passed", &identity).is_err());
        assert_eq!(c.execution.step, ValidationStep::Review);
    }
}

const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CORRECTED_HEAD: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DEPLOYED: &str = "cccccccccccccccccccccccccccccccccccccccc";

struct LabContext {
    execution: ValidationExecution,
    store: ValidationStore,
    checks: Vec<ValidationLabCheck>,
    root: PathBuf,
}
impl LabContext {
    fn new(root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let mut execution = ValidationExecution::new(
            "offline-lab".into(),
            "offline-worktree".into(),
            root.join("scripted-repository")
                .to_string_lossy()
                .into_owned(),
            "offline-ticket".into(),
            Some(42),
        );
        execution.head_commit = Some(HEAD.into());
        execution
            .requirements
            .push(criterion(RequirementStatus::Unverified, vec![]));
        execution.limitations.push(
            "LAB HORS LIGNE : agents, CI et déploiement simulés ; aucune recette de service réel."
                .into(),
        );
        let store = ValidationStore::new(root);
        store.save(&execution)?;
        Ok(Self {
            execution,
            store,
            checks: vec![],
            root: root.to_path_buf(),
        })
    }
    fn check(&mut self, label: impl Into<String>, passed: bool) {
        self.checks.push(ValidationLabCheck {
            label: label.into(),
            passed,
        });
    }
    fn script(
        &mut self,
        outcome: StepOutcome,
        commit: &str,
        requirements: Vec<Requirement>,
        evidence: Vec<Evidence>,
        defects: Vec<Defect>,
        deployed_commit: Option<&str>,
    ) -> Result<StepResult, String> {
        let identity = validation_engine::begin_attempt(&mut self.execution)?;
        // Intention persisted before accepting any scripted output, as in real execution.
        self.store.save(&self.execution)?;
        let result = StepResult {
            identity: identity.clone(),
            outcome,
            commit: commit.into(),
            requirements,
            defects,
            evidence,
            message: Some("Résultat scripté du laboratoire — services simulés".into()),
            deployed_commit: deployed_commit.map(str::to_string),
        };
        let json = serde_json::to_string(&result).map_err(|e| e.to_string())?;
        let parsed = parse_agent_result(&json, &identity)?;
        validation_engine::apply_result(&mut self.execution, parsed)?;
        self.store.save(&self.execution)?;
        self.execution = self
            .store
            .get(&self.execution.id)?
            .ok_or("Lab snapshot missing")?;
        Ok(result)
    }
    fn passed(&mut self) -> Result<(), String> {
        let head = self
            .execution
            .head_commit
            .clone()
            .ok_or("Missing lab head")?;
        self.script(StepOutcome::Passed, &head, vec![], vec![], vec![], None)?;
        Ok(())
    }
    fn prepare_acceptance(&mut self) -> Result<(), String> {
        let head = self
            .execution
            .head_commit
            .clone()
            .ok_or("Missing lab head")?;
        self.script(
            StepOutcome::Passed,
            &head,
            vec![criterion(
                RequirementStatus::Passed,
                vec!["review-test".into()],
            )],
            vec![proof("review-test", "test", &head)],
            vec![],
            None,
        )?;
        self.passed()?;
        self.script(
            StepOutcome::Passed,
            &head,
            vec![],
            vec![proof("ci-head", "backend-ci", &head)],
            vec![],
            None,
        )?;
        self.script(
            StepOutcome::Passed,
            &head,
            vec![],
            vec![proof("preview-version", "git-ancestry", &head)],
            vec![],
            Some(DEPLOYED),
        )?;
        self.check(
            "La chaîne Review → GitSync → CI → Preview atteint la recette",
            self.execution.step == ValidationStep::Acceptance,
        );
        Ok(())
    }
    fn finish_acceptance(&mut self) -> Result<(), String> {
        let head = self
            .execution
            .head_commit
            .clone()
            .ok_or("Missing lab head")?;
        self.script(
            StepOutcome::Passed,
            &head,
            vec![criterion(
                RequirementStatus::Passed,
                vec!["acceptance-test".into()],
            )],
            vec![proof("acceptance-test", "acceptance", &head)],
            vec![],
            None,
        )?;
        Ok(())
    }
}
fn criterion(status: RequirementStatus, evidence_ids: Vec<String>) -> Requirement {
    Requirement {
        id: "ticket-save-reload".into(),
        label: "Sauvegarder puis recharger conserve la valeur (scénario simulé)".into(),
        mandatory: true,
        status,
        evidence_ids,
        justification: None,
    }
}
fn proof(id: &str, kind: &str, commit: &str) -> Evidence {
    Evidence {
        id: id.into(),
        label: format!("Preuve simulée : {id}"),
        kind: kind.into(),
        value: "SIMULATION HORS LIGNE — assertion scriptée, aucun service réel appelé".into(),
        commit: commit.into(),
        stale: false,
    }
}
fn enum_name<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

fn happy(c: &mut LabContext) -> Result<(), String> {
    c.prepare_acceptance()?;
    c.finish_acceptance()?;
    c.check(
        "Ready exige CI, inclusion preview et recette fraîche",
        c.execution.status == ValidationStatus::Ready && validation_engine::is_ready(&c.execution),
    );
    c.check(
        "Aucun effet externe ni session réelle créés",
        c.execution.effects.is_empty() && c.execution.active_session_id.is_none(),
    );
    Ok(())
}

fn unpublished_to_pr(c: &mut LabContext) -> Result<(), String> {
    c.execution = ValidationExecution::new(
        "offline-lab".into(),
        "offline-worktree".into(),
        c.root
            .join("scripted-repository")
            .to_string_lossy()
            .into_owned(),
        "offline-ticket".into(),
        None,
    );
    c.execution.publication_base_branch = Some("main".into());
    c.execution.head_commit = Some(HEAD.into());
    c.execution.limitations.push(
        "LAB : implémentation et publication entièrement simulées, aucun agent/push/PR réel."
            .into(),
    );
    c.check(
        "Un ticket sans PR commence par l’implémentation",
        c.execution.step == ValidationStep::Implementation,
    );
    c.script(
        StepOutcome::Passed,
        CORRECTED_HEAD,
        vec![criterion(
            RequirementStatus::Passed,
            vec!["implementation-test".into()],
        )],
        vec![proof("implementation-test", "test", CORRECTED_HEAD)],
        vec![],
        None,
    )?;
    c.check(
        "L’implémentation ne remplace pas la revue indépendante",
        c.execution.step == ValidationStep::Review && c.execution.status != ValidationStatus::Ready,
    );
    c.script(
        StepOutcome::Passed,
        CORRECTED_HEAD,
        vec![criterion(
            RequirementStatus::Passed,
            vec!["review-test".into()],
        )],
        vec![proof("review-test", "test", CORRECTED_HEAD)],
        vec![],
        None,
    )?;
    c.check(
        "La revue précède le premier push",
        c.execution.step == ValidationStep::GitSync,
    );
    c.execution.effects.push(ExternalEffect {
        id: "lab-first-push".into(),
        kind: "push".into(),
        intended_commit: CORRECTED_HEAD.into(),
        confirmed: true,
    });
    c.passed()?;
    c.check(
        "Sans PR, le push mène à sa création et non directement à la CI",
        c.execution.step == ValidationStep::CreatePr && c.execution.pr_number.is_none(),
    );
    Ok(())
}

fn fresh_ticket(c: &mut LabContext) -> Result<(), String> {
    unpublished_to_pr(c)?;
    c.execution.effects.push(ExternalEffect {
        id: "lab-create-pr".into(),
        kind: "create_pr".into(),
        intended_commit: CORRECTED_HEAD.into(),
        confirmed: true,
    });
    c.execution.pr_number = Some(42);
    c.passed()?;
    c.check(
        "La PR confirmée permet ensuite la CI",
        c.execution.step == ValidationStep::Ci,
    );
    c.script(
        StepOutcome::Passed,
        CORRECTED_HEAD,
        vec![],
        vec![proof("ci-head", "backend-ci", CORRECTED_HEAD)],
        vec![],
        None,
    )?;
    c.script(
        StepOutcome::Passed,
        CORRECTED_HEAD,
        vec![],
        vec![proof("preview-version", "git-ancestry", CORRECTED_HEAD)],
        vec![],
        Some(DEPLOYED),
    )?;
    c.check(
        "Le ticket neuf doit lui aussi passer la recette",
        c.execution.step == ValidationStep::Acceptance
            && c.execution.status != ValidationStatus::Ready,
    );
    c.finish_acceptance()?;
    c.check(
        "Prêt uniquement après preuves métier fraîches",
        c.execution.status == ValidationStatus::Ready && validation_engine::is_ready(&c.execution),
    );
    Ok(())
}

fn fresh_pr_recovery(c: &mut LabContext) -> Result<(), String> {
    unpublished_to_pr(c)?;
    let identity = validation_engine::begin_attempt(&mut c.execution)?;
    c.execution.effects.push(ExternalEffect {
        id: identity.attempt_id.clone(),
        kind: "create_pr".into(),
        intended_commit: CORRECTED_HEAD.into(),
        confirmed: false,
    });
    c.store.save(&c.execution)?;
    let recovered = c
        .store
        .get(&c.execution.id)?
        .ok_or("Intention PR du lab absente")?;
    c.check(
        "L’interruption conserve l’identité et l’intention avant création",
        recovered.active_attempt.as_ref() == Some(&identity)
            && recovered
                .effects
                .iter()
                .filter(|e| e.kind == "create_pr")
                .count()
                == 1,
    );
    c.execution = recovered;
    // Script the observed PR from the backend reconciliation, without publishing.
    c.execution.pr_number = Some(42);
    c.execution
        .effects
        .iter_mut()
        .filter(|e| e.kind == "create_pr")
        .for_each(|e| e.confirmed = true);
    validation_engine::apply_result(
        &mut c.execution,
        StepResult {
            identity,
            outcome: StepOutcome::Passed,
            commit: CORRECTED_HEAD.into(),
            requirements: vec![],
            defects: vec![],
            evidence: vec![],
            deployed_commit: None,
            message: Some("LAB : PR retrouvée, aucune création dupliquée".into()),
        },
    )?;
    c.store.save(&c.execution)?;
    c.check(
        "Une seule intention réconciliée, puis CI",
        c.execution.step == ValidationStep::Ci
            && c.execution.active_attempt.is_none()
            && c.execution
                .effects
                .iter()
                .filter(|e| e.kind == "create_pr")
                .count()
                == 1
            && c.execution.effects.iter().all(|e| e.confirmed),
    );
    Ok(())
}
fn acceptance_correction(c: &mut LabContext) -> Result<(), String> {
    c.prepare_acceptance()?;
    c.script(
        StepOutcome::Failed,
        HEAD,
        vec![criterion(
            RequirementStatus::Failed,
            vec!["acceptance-failure".into()],
        )],
        vec![proof("acceptance-failure", "acceptance", HEAD)],
        vec![Defect {
            id: "save-loss".into(),
            description: "SIMULÉ : sauvegarder puis recharger perd la valeur".into(),
            mandatory: true,
            resolved: false,
            evidence_ids: vec!["acceptance-failure".into()],
        }],
        None,
    )?;
    c.check(
        "Défaut fonctionnel détecté en recette → Correction",
        c.execution.step == ValidationStep::Correction
            && c.execution.status == ValidationStatus::Pending,
    );
    c.script(
        StepOutcome::Passed,
        CORRECTED_HEAD,
        vec![],
        vec![],
        vec![],
        None,
    )?;
    c.check(
        "Le nouveau head invalide toutes les anciennes preuves",
        c.execution.evidence.iter().all(|e| e.stale)
            && c.execution.deployed_commit.is_none()
            && c.execution.acceptance_evidence_ids.is_empty(),
    );
    c.script(
        StepOutcome::Passed,
        CORRECTED_HEAD,
        vec![criterion(
            RequirementStatus::Passed,
            vec!["regression-test".into()],
        )],
        vec![proof("regression-test", "test", CORRECTED_HEAD)],
        vec![Defect {
            id: "save-loss".into(),
            description: "SIMULÉ : défaut exact résolu avec régression".into(),
            mandatory: true,
            resolved: true,
            evidence_ids: vec!["regression-test".into()],
        }],
        None,
    )?;
    c.check(
        "Review indépendante après correction → GitSync",
        c.execution.step == ValidationStep::GitSync,
    );
    c.passed()?;
    c.script(
        StepOutcome::Passed,
        CORRECTED_HEAD,
        vec![],
        vec![proof("ci-head", "backend-ci", CORRECTED_HEAD)],
        vec![],
        None,
    )?;
    c.script(
        StepOutcome::Passed,
        CORRECTED_HEAD,
        vec![],
        vec![proof("preview-version", "git-ancestry", CORRECTED_HEAD)],
        vec![],
        Some(DEPLOYED),
    )?;
    c.check(
        "Retour en recette après CI et preview du nouveau head",
        c.execution.step == ValidationStep::Acceptance
            && !validation_engine::is_ready(&c.execution),
    );
    c.finish_acceptance()?;
    c.check(
        "Ready seulement après nouvelle recette ; IDs et compteur conservés",
        c.execution.status == ValidationStatus::Ready
            && c.execution.head_commit.as_deref() == Some(CORRECTED_HEAD)
            && c.execution.correction_cycles == 1
            && c.execution.defects[0].id == "save-loss",
    );
    Ok(())
}
fn missing_evidence(c: &mut LabContext) -> Result<(), String> {
    c.prepare_acceptance()?;
    c.script(
        StepOutcome::Passed,
        HEAD,
        vec![criterion(
            RequirementStatus::Passed,
            vec!["missing-proof".into()],
        )],
        vec![],
        vec![],
        None,
    )?;
    c.check(
        "Un passed sans preuve existante ne devient jamais Ready",
        c.execution.status == ValidationStatus::Blocked
            && c.execution.step == ValidationStep::Acceptance,
    );
    c.check(
        "Aucune correction aveugle pour preuve absente",
        c.execution.correction_cycles == 0,
    );
    Ok(())
}
fn mandatory(c: &mut LabContext) -> Result<(), String> {
    c.execution.requirements[0].status = RequirementStatus::Failed;
    c.passed()?;
    c.check(
        "Une exigence obligatoire omise reste Failed et déclenche correction",
        c.execution.requirements[0].mandatory
            && c.execution.requirements[0].status == RequirementStatus::Failed
            && c.execution.step == ValidationStep::Correction,
    );
    let identity = validation_engine::begin_attempt(&mut c.execution)?;
    let revision = c.execution.revision;
    let mut downgraded = criterion(RequirementStatus::Passed, vec![]);
    downgraded.mandatory = false;
    let result = StepResult {
        identity,
        outcome: StepOutcome::Passed,
        commit: HEAD.into(),
        requirements: vec![downgraded],
        defects: vec![],
        evidence: vec![],
        message: None,
        deployed_commit: None,
    };
    let rejected = validation_engine::apply_result(&mut c.execution, result).is_err();
    c.check(
        "Rétrograder mandatory est refusé sans mutation",
        rejected && c.execution.revision == revision && c.execution.requirements[0].mandatory,
    );
    Ok(())
}
fn stale_duplicate(c: &mut LabContext) -> Result<(), String> {
    let identity = validation_engine::begin_attempt(&mut c.execution)?;
    let revision = c.execution.revision;
    let mut result = StepResult {
        identity: identity.clone(),
        outcome: StepOutcome::Passed,
        commit: HEAD.into(),
        requirements: vec![],
        defects: vec![],
        evidence: vec![],
        message: None,
        deployed_commit: None,
    };
    result.identity.attempt_id = uuid::Uuid::new_v4().to_string();
    let json = serde_json::to_string(&result).map_err(|e| e.to_string())?;
    c.check(
        "Le parser rejette une identité tardive",
        parse_agent_result(&json, &identity).is_err(),
    );
    let rejected = validation_engine::apply_result(&mut c.execution, result.clone()).is_err();
    c.check(
        "Le moteur refuse un résultat tardif sans changement de révision",
        rejected && c.execution.revision == revision,
    );
    result.identity = identity;
    validation_engine::apply_result(&mut c.execution, result.clone())?;
    let revision = c.execution.revision;
    let rejected = validation_engine::apply_result(&mut c.execution, result).is_err();
    c.check(
        "Un résultat déjà appliqué ne peut être appliqué deux fois",
        rejected && c.execution.revision == revision,
    );
    Ok(())
}
fn limits(c: &mut LabContext) -> Result<(), String> {
    c.execution.correction_cycles = 3;
    c.execution.step = ValidationStep::Acceptance;
    c.execution.requirements[0].status = RequirementStatus::Failed;
    c.script(StepOutcome::Failed, HEAD, vec![], vec![], vec![], None)?;
    c.check(
        "Au plafond de trois cycles, un nouveau défaut bloque sans reset",
        c.execution.status == ValidationStatus::Blocked && c.execution.correction_cycles == 3,
    );
    // Independent fixture: never reset counters on the capped execution.
    let mut no_progress = LabContext::new(&c.root.join("independent-no-progress"))?;
    no_progress.execution.step = ValidationStep::Correction;
    for _ in 0..2 {
        no_progress.script(
            StepOutcome::CorrectionRequired,
            HEAD,
            vec![],
            vec![],
            vec![],
            None,
        )?;
    }
    c.check(
        "Exécution distincte : deux tentatives sans progrès bloquent",
        no_progress.execution.status == ValidationStatus::Blocked
            && no_progress.execution.no_progress_cycles == 2
            && no_progress.execution.correction_cycles == 2,
    );
    let rejected = validation_engine::begin_attempt(&mut no_progress.execution).is_err();
    c.check("Une tentative supplémentaire est refusée", rejected);
    Ok(())
}
fn pause_resume(c: &mut LabContext) -> Result<(), String> {
    let identity = validation_engine::begin_attempt(&mut c.execution)?;
    validation_engine::pause(&mut c.execution);
    c.store.save(&c.execution)?;
    c.execution = c
        .store
        .get(&c.execution.id)?
        .ok_or("Lab recovery missing")?;
    let rejected = validation_engine::begin_attempt(&mut c.execution).is_err();
    c.check(
        "Pause conservée avec tentative active, sans en créer une seconde",
        c.execution.paused && c.execution.active_attempt.as_ref() == Some(&identity) && rejected,
    );
    let result = StepResult {
        identity,
        outcome: StepOutcome::Passed,
        commit: HEAD.into(),
        requirements: vec![],
        defects: vec![],
        evidence: vec![],
        message: Some("Réconciliation scriptée du résultat en cours".into()),
        deployed_commit: None,
    };
    validation_engine::apply_result(&mut c.execution, result.clone())?;
    let rejected = validation_engine::begin_attempt(&mut c.execution).is_err();
    c.check(
        "Le résultat en cours est réconcilié sans annulation de session",
        c.execution.active_attempt.is_none() && c.execution.paused && rejected,
    );
    c.execution.paused = false;
    validation_engine::record(&mut c.execution, "Reprise explicite simulée");
    let next = validation_engine::begin_attempt(&mut c.execution)?;
    let rejected = validation_engine::begin_attempt(&mut c.execution).is_err();
    c.check(
        "Reprise : nouvelle étape, une seule tentative distincte",
        next.attempt_id != result.identity.attempt_id
            && next.step == ValidationStep::GitSync
            && rejected,
    );
    Ok(())
}
fn recovery(c: &mut LabContext) -> Result<(), String> {
    c.prepare_acceptance()?;
    c.finish_acceptance()?;
    c.store.save(&c.execution)?;
    let loaded = c
        .store
        .get(&c.execution.id)?
        .ok_or("Lab recovery missing")?;
    c.check(
        "Snapshot terminal round-trip exact",
        serde_json::to_value(&loaded).map_err(|e| e.to_string())?
            == serde_json::to_value(&c.execution).map_err(|e| e.to_string())?,
    );
    c.execution = loaded;
    let rejected = validation_engine::begin_attempt(&mut c.execution).is_err();
    c.check(
        "Un Ready restauré ne lance pas un nouveau run",
        rejected && c.execution.active_attempt.is_none(),
    );
    // A second independent execution models crash between persisted intent and result.
    let mut interrupted = ValidationExecution::new(
        "offline-lab".into(),
        "recovery-worktree".into(),
        c.root.join("recovery-repo").to_string_lossy().into_owned(),
        "offline-ticket".into(),
        Some(42),
    );
    let identity = validation_engine::begin_attempt(&mut interrupted)?;
    c.store.save(&interrupted)?;
    let result = StepResult {
        identity: identity.clone(),
        outcome: StepOutcome::Passed,
        commit: HEAD.into(),
        requirements: vec![],
        defects: vec![],
        evidence: vec![],
        message: None,
        deployed_commit: None,
    };
    let json = serde_json::to_string(&result).map_err(|e| e.to_string())?;
    interrupted = c
        .store
        .get(&interrupted.id)?
        .ok_or("Interrupted snapshot missing")?;
    validation_engine::apply_result(&mut interrupted, parse_agent_result(&json, &identity)?)?;
    c.store.save(&interrupted)?;
    interrupted = c
        .store
        .get(&interrupted.id)?
        .ok_or("Reconciled snapshot missing")?;
    let revision = interrupted.revision;
    c.check(
        "Résultat terminal de tentative appliqué une seule fois après crash simulé",
        validation_engine::apply_result(&mut interrupted, result).is_err()
            && interrupted.revision == revision
            && interrupted.step == ValidationStep::GitSync,
    );
    Ok(())
}

/// Only local Git commands; clean environment, no hooks/signing, no remote.
fn local_git(root: &Path, repository: &Path, args: &[&str]) -> Result<String, String> {
    let hooks = root.join("empty-hooks");
    std::fs::create_dir_all(&hooks).map_err(|e| e.to_string())?;
    let config = root.join("empty-gitconfig");
    std::fs::write(&config, "").map_err(|e| e.to_string())?;
    let mut command = crate::platform::silent_command("git");
    command.env_clear();
    for name in ["PATH", "SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("HOME", root)
        .env("USERPROFILE", root)
        .env("TMPDIR", root)
        .env("TEMP", root)
        .env("TMP", root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", &config)
        .env("GIT_TERMINAL_PROMPT", "0");
    let hooks_config = format!("core.hooksPath={}", hooks.to_string_lossy());
    let output = command
        .args([
            "-c",
            &hooks_config,
            "-c",
            "commit.gpgsign=false",
            "-c",
            "tag.gpgSign=false",
            "-c",
            "user.name=Jean Offline Lab",
            "-c",
            "user.email=offline-lab@example.invalid",
        ])
        .args(args)
        .current_dir(repository)
        .output()
        .map_err(|e| format!("Git local indisponible : {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Échec Git local : {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
struct LocalHistory {
    repository: PathBuf,
    pr_head: String,
    other_head: String,
    merge_head: String,
}
fn local_history(c: &mut LabContext) -> Result<LocalHistory, String> {
    let repository = c.root.join("local-git-repository");
    std::fs::create_dir_all(&repository).map_err(|e| e.to_string())?;
    let git = |args: &[&str]| local_git(&c.root, &repository, args);
    git(&["init", "-b", "main"])?;
    git(&["commit", "--allow-empty", "-m", "offline base"])?;
    git(&["checkout", "-b", "scripted-pr"])?;
    git(&["commit", "--allow-empty", "-m", "offline PR"])?;
    let pr_head = git(&["rev-parse", "HEAD"])?;
    git(&["checkout", "main"])?;
    git(&["commit", "--allow-empty", "-m", "offline main"])?;
    let other_head = git(&["rev-parse", "HEAD"])?;
    git(&[
        "merge",
        "--no-ff",
        "-m",
        "offline merge deployment",
        "scripted-pr",
    ])?;
    let merge_head = git(&["rev-parse", "HEAD"])?;
    c.execution.repository_path = repository.to_string_lossy().into_owned();
    c.check(
        "Dépôt Git local sans aucun remote",
        git(&["remote"])?.is_empty(),
    );
    Ok(LocalHistory {
        repository,
        pr_head,
        other_head,
        merge_head,
    })
}
fn preview_ancestry(c: &mut LabContext) -> Result<(), String> {
    let history = local_history(c)?;
    let included = super::preview_version::verify_inclusion(
        &history.repository,
        &history.pr_head,
        &history.merge_head,
    );
    c.check(
        "Le SHA de merge diffère du head PR",
        history.pr_head != history.merge_head,
    );
    c.check(
        "Le vrai contrôle Git prouve l’inclusion malgré les SHA différents",
        included == super::preview_version::PreviewInclusion::Included,
    );
    c.execution.head_commit = Some(history.pr_head);
    c.execution.deployed_commit = Some(history.merge_head);
    validation_engine::record(
        &mut c.execution,
        "Contrôle Git local réel ; aucun déploiement/preview interrogé",
    );
    Ok(())
}
fn preview_unknown(c: &mut LabContext) -> Result<(), String> {
    let history = local_history(c)?;
    c.check(
        "Historique complet divergent : NotIncluded",
        super::preview_version::verify_inclusion(
            &history.repository,
            &history.pr_head,
            &history.other_head,
        ) == super::preview_version::PreviewInclusion::NotIncluded,
    );
    c.check(
        "Objet absent : Unknown, jamais preview obsolète",
        super::preview_version::verify_inclusion(
            &history.repository,
            &"0".repeat(40),
            &history.merge_head,
        ) == super::preview_version::PreviewInclusion::Unknown,
    );
    // Mark this disposable local history shallow; no fetch/network necessary.
    std::fs::write(
        history.repository.join(".git/shallow"),
        format!("{}\n", history.merge_head),
    )
    .map_err(|e| e.to_string())?;
    c.check(
        "Historique shallow : divergence non confirmée reste Unknown",
        super::preview_version::verify_inclusion(
            &history.repository,
            &history.pr_head,
            &history.other_head,
        ) == super::preview_version::PreviewInclusion::Unknown,
    );
    validation_engine::record(
        &mut c.execution,
        "Historique incomplet local ; aucun serveur contacté",
    );
    Ok(())
}

type ScenarioRunner = fn(&mut LabContext) -> Result<(), String>;
fn run_all_with_cleanup() -> Result<(ValidationLabReport, PathBuf), String> {
    let temporary = tempfile::Builder::new()
        .prefix("jean-offline-validation-lab-")
        .tempdir()
        .map_err(|e| format!("Laboratoire temporaire indisponible : {e}"))?;
    let root = temporary.path().to_path_buf();
    let definitions: [(&str, &str, ScenarioRunner); 12] = [
        ("happy-path", "Validation complète", happy),
        (
            "fresh-ticket",
            "Ticket sans PR : implémentation → PR → recette",
            fresh_ticket,
        ),
        (
            "fresh-pr-recovery",
            "Création PR interrompue : intention réconciliée",
            fresh_pr_recovery,
        ),
        (
            "acceptance-correction",
            "Défaut en recette → correction → nouvelle recette",
            acceptance_correction,
        ),
        (
            "missing-evidence",
            "Preuve absente : pas de faux succès",
            missing_evidence,
        ),
        (
            "mandatory-obligations",
            "Critères obligatoires conservés",
            mandatory,
        ),
        (
            "stale-duplicate",
            "Résultats périmés et doublons refusés",
            stale_duplicate,
        ),
        (
            "correction-limits",
            "Limites globales de correction",
            limits,
        ),
        (
            "pause-resume",
            "Pause et reprise sans double tentative",
            pause_resume,
        ),
        (
            "persistence-recovery",
            "Persistance et reprise après interruption",
            recovery,
        ),
        (
            "preview-ancestry",
            "SHA différents, inclusion Git réelle",
            preview_ancestry,
        ),
        (
            "preview-unknown",
            "Divergence et historique non confirmable",
            preview_unknown,
        ),
    ];
    let mut scenarios = vec![];
    for (id, label, runner) in definitions {
        let mut context = LabContext::new(&root.join(id))?;
        if let Err(error) = runner(&mut context) {
            context.check(format!("Erreur du scénario : {error}"), false);
        }
        let passed = !context.checks.is_empty() && context.checks.iter().all(|check| check.passed);
        let transitions = context
            .execution
            .transitions
            .iter()
            .map(|t| ValidationLabTransition {
                step: enum_name(t.step),
                status: enum_name(t.status),
                message: format!("LAB : {}", t.message),
            })
            .collect();
        scenarios.push(ValidationLabScenario { id: id.into(), label: label.into(), passed, summary: "Moteur, parser et stockage réels ; agents, CI et preview simulés. Git éventuel strictement local. Ce rapport n’est pas une validation d’un ticket réel.".into(), checks: context.checks, transitions, execution: Some(context.execution) });
    }
    let total_count = scenarios.len();
    let passed_count = scenarios.iter().filter(|s| s.passed).count();
    // An explicit close reports cleanup failures instead of claiming isolation silently.
    temporary
        .close()
        .map_err(|e| format!("Nettoyage du laboratoire temporaire échoué : {e}"))?;
    Ok((
        ValidationLabReport {
            scenarios,
            passed_count,
            total_count,
            isolated: true,
        },
        root,
    ))
}

pub async fn run_ai_pipeline_validation_lab() -> Result<ValidationLabReport, String> {
    tokio::task::spawn_blocking(|| run_all_with_cleanup().map(|(report, _)| report))
        .await
        .map_err(|e| format!("Le banc d’essai a été interrompu ou a paniqué : {e}"))?
}
