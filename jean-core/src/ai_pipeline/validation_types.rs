//! Private validation state. Persisted names deliberately stay snake_case.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationStatus {
    Pending,
    Running,
    Waiting,
    Blocked,
    Failed,
    Ready,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationStep {
    Implementation,
    CreatePr,
    Review,
    Correction,
    GitSync,
    Ci,
    Preview,
    Acceptance,
    Complete,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    Passed,
    Failed,
    Unverified,
    NotApplicable,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Requirement {
    pub id: String,
    pub label: String,
    pub mandatory: bool,
    pub status: RequirementStatus,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub justification: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub value: String,
    pub commit: String,
    #[serde(default)]
    pub stale: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Defect {
    pub id: String,
    pub description: String,
    pub mandatory: bool,
    pub resolved: bool,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepIdentity {
    pub execution_id: String,
    pub step: ValidationStep,
    pub attempt_id: String,
    pub input_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    pub revision: u64,
    pub step: ValidationStep,
    pub status: ValidationStatus,
    pub message: String,
    pub timestamp: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalEffect {
    pub id: String,
    pub kind: String,
    pub intended_commit: String,
    pub confirmed: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationAgentSession {
    pub session_id: String,
    pub step: ValidationStep,
    pub attempt_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationExecution {
    pub schema_version: u32,
    pub id: String,
    pub project_id: String,
    pub worktree_id: String,
    pub repository_path: String,
    #[serde(default)]
    pub runtime_config_baseline: Option<super::runtime_config::RuntimeConfigBaseline>,
    #[serde(default)]
    pub original_branch: Option<String>,
    #[serde(default)]
    pub publication_base_branch: Option<String>,
    #[serde(default)]
    pub publication_remote_identity: Option<String>,
    pub task_id: String,
    pub pr_number: Option<u32>,
    pub revision: u64,
    pub step: ValidationStep,
    pub status: ValidationStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub head_commit: Option<String>,
    #[serde(default)]
    pub deployed_commit: Option<String>,
    #[serde(default)]
    pub last_ready_check: Option<String>,
    #[serde(default)]
    pub criteria_fingerprint: Option<String>,
    #[serde(default)]
    pub active_attempt: Option<StepIdentity>,
    #[serde(default)]
    pub active_session_id: Option<String>,
    #[serde(default)]
    pub agent_sessions: Vec<ValidationAgentSession>,
    #[serde(default)]
    pub correction_cycles: u8,
    #[serde(default)]
    pub waiting_since: Option<String>,
    #[serde(default)]
    pub no_progress_cycles: u8,
    #[serde(default)]
    pub requirements: Vec<Requirement>,
    #[serde(default)]
    pub defects: Vec<Defect>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    #[serde(default)]
    pub acceptance_evidence_ids: Vec<String>,
    #[serde(default)]
    pub effects: Vec<ExternalEffect>,
    #[serde(default)]
    pub transitions: Vec<Transition>,
    #[serde(default)]
    pub blocker: Option<String>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub superseded_by: Option<String>,
    #[serde(default)]
    pub correction_pending_verification: bool,
    #[serde(default)]
    pub progress_baseline: Vec<String>,
    #[serde(default)]
    pub limitations: Vec<String>,
}
impl ValidationExecution {
    pub fn new(
        project_id: String,
        worktree_id: String,
        repository_path: String,
        task_id: String,
        pr_number: Option<u32>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            project_id,
            worktree_id,
            repository_path,
            runtime_config_baseline: None,
            original_branch: None,
            publication_base_branch: None,
            publication_remote_identity: None,
            task_id,
            pr_number,
            revision: 0,
            step: if pr_number.is_none() {
                ValidationStep::Implementation
            } else {
                ValidationStep::Review
            },
            status: ValidationStatus::Pending,
            created_at: now.clone(),
            updated_at: now,
            head_commit: None,
            deployed_commit: None,
            last_ready_check: None,
            criteria_fingerprint: None,
            active_attempt: None,
            active_session_id: None,
            agent_sessions: vec![],
            correction_cycles: 0,
            waiting_since: None,
            no_progress_cycles: 0,
            requirements: vec![],
            defects: vec![],
            evidence: vec![],
            acceptance_evidence_ids: vec![],
            effects: vec![],
            transitions: vec![],
            blocker: None,
            paused: false,
            superseded_by: None,
            correction_pending_verification: false,
            progress_baseline: vec![],
            limitations: vec![],
        }
    }
    /// Retain explicit provenance even after the coordinator clears the active session.
    pub fn record_agent_session(&mut self, session_id: String, identity: &StepIdentity) {
        if !self
            .agent_sessions
            .iter()
            .any(|session| session.session_id == session_id)
        {
            self.agent_sessions.push(ValidationAgentSession {
                session_id: session_id.clone(),
                step: identity.step,
                attempt_id: identity.attempt_id.clone(),
            });
        }
        self.active_session_id = Some(session_id);
    }
    pub fn is_active(&self) -> bool {
        self.superseded_by.is_none()
            && !matches!(
                self.status,
                ValidationStatus::Ready | ValidationStatus::Failed
            )
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepOutcome {
    Passed,
    CorrectionRequired,
    Waiting,
    Blocked,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    pub identity: StepIdentity,
    pub outcome: StepOutcome,
    pub commit: String,
    #[serde(default)]
    pub requirements: Vec<Requirement>,
    #[serde(default)]
    pub defects: Vec<Defect>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub deployed_commit: Option<String>,
}

#[cfg(test)]
mod session_provenance_tests {
    use super::*;

    #[test]
    fn legacy_execution_defaults_to_no_agent_sessions() {
        let execution = ValidationExecution::new(
            "project".into(),
            "worktree".into(),
            "/repo".into(),
            "task".into(),
            Some(42),
        );
        let mut json = serde_json::to_value(&execution).unwrap();
        json.as_object_mut().unwrap().remove("agent_sessions");
        let restored: ValidationExecution = serde_json::from_value(json).unwrap();
        assert!(restored.agent_sessions.is_empty());
    }

    #[test]
    fn session_provenance_survives_clearing_active_session() {
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
        execution.record_agent_session("session".into(), &identity);
        execution.record_agent_session("session".into(), &identity);
        assert_eq!(execution.active_session_id.as_deref(), Some("session"));
        execution.active_session_id = None;
        let restored: ValidationExecution =
            serde_json::from_value(serde_json::to_value(execution).unwrap()).unwrap();
        assert_eq!(restored.agent_sessions.len(), 1);
        assert_eq!(restored.agent_sessions[0].session_id, "session");
        assert_eq!(restored.agent_sessions[0].step, ValidationStep::Review);
        assert_eq!(restored.agent_sessions[0].attempt_id, "attempt");
    }

    #[test]
    fn separate_correction_sessions_keep_their_attempt_identity() {
        let mut execution = ValidationExecution::new(
            "project".into(),
            "worktree".into(),
            "/repo".into(),
            "task".into(),
            Some(42),
        );
        for attempt in ["first", "second"] {
            let identity = StepIdentity {
                execution_id: execution.id.clone(),
                step: ValidationStep::Correction,
                attempt_id: attempt.into(),
                input_revision: 1,
            };
            execution.record_agent_session(format!("session-{attempt}"), &identity);
        }
        assert_eq!(execution.agent_sessions.len(), 2);
        assert_eq!(execution.agent_sessions[0].attempt_id, "first");
        assert_eq!(execution.agent_sessions[1].attempt_id, "second");
        assert_eq!(
            execution.active_session_id.as_deref(),
            Some("session-second")
        );
    }
}
