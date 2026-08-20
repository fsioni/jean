use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use uuid::Uuid;

use crate::http_server::EmitExt;
use crate::projects::types::RunPolicyMode;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ManagedRunStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
    Orphaned,
}

impl ManagedRunStatus {
    fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Stopping)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRun {
    pub id: String,
    pub project_id: String,
    pub worktree_id: String,
    pub terminal_id: String,
    pub script_id: String,
    pub command: String,
    pub status: ManagedRunStatus,
    pub base_port: Option<u16>,
    pub port_count: u16,
    pub pid: Option<u32>,
    #[serde(default)]
    pub process_started_at: Option<u64>,
    #[serde(default)]
    pub command_fingerprint: Option<String>,
    pub started_at: u64,
    pub stopped_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

impl ManagedRun {
    #[allow(clippy::too_many_arguments)]
    pub fn starting(
        id: String,
        project_id: String,
        worktree_id: String,
        terminal_id: String,
        script_id: String,
        command: String,
        base_port: Option<u16>,
        port_count: u16,
    ) -> Self {
        Self {
            id,
            project_id,
            worktree_id,
            terminal_id,
            script_id,
            command,
            status: ManagedRunStatus::Starting,
            base_port,
            port_count,
            pid: None,
            process_started_at: None,
            command_fingerprint: None,
            started_at: now(),
            stopped_at: None,
            exit_code: None,
            error: None,
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct RunRegistry {
    #[serde(default)]
    runs: Vec<ManagedRun>,
}

impl RunRegistry {
    pub fn insert(&mut self, run: ManagedRun) {
        self.runs.retain(|existing| existing.id != run.id);
        self.runs.push(run);
    }

    pub fn get(&self, run_id: &str) -> Option<&ManagedRun> {
        self.runs.iter().find(|run| run.id == run_id)
    }

    pub fn get_mut(&mut self, run_id: &str) -> Option<&mut ManagedRun> {
        self.runs.iter_mut().find(|run| run.id == run_id)
    }

    pub fn project_runs(&self, project_id: &str) -> Vec<ManagedRun> {
        self.runs
            .iter()
            .filter(|run| run.project_id == project_id)
            .cloned()
            .collect()
    }

    pub fn workspace_runs(&self, worktree_id: &str) -> Vec<ManagedRun> {
        self.runs
            .iter()
            .filter(|run| run.worktree_id == worktree_id)
            .cloned()
            .collect()
    }

    pub fn find_active_script(&self, worktree_id: &str, script_id: &str) -> Option<&ManagedRun> {
        self.runs.iter().find(|run| {
            run.worktree_id == worktree_id && run.script_id == script_id && run.status.is_active()
        })
    }

    pub fn runs_to_stop_before_start(
        &self,
        mode: RunPolicyMode,
        project_id: &str,
        worktree_id: &str,
        script_id: &str,
    ) -> Vec<String> {
        if mode != RunPolicyMode::Exclusive {
            return Vec::new();
        }
        self.runs
            .iter()
            .filter(|run| {
                run.project_id == project_id
                    && run.status.is_active()
                    && !(run.worktree_id == worktree_id && run.script_id == script_id)
            })
            .map(|run| run.id.clone())
            .collect()
    }

    pub fn terminal_exited(
        &mut self,
        terminal_id: &str,
        exit_code: Option<i32>,
        signal: Option<&str>,
    ) -> Option<ManagedRun> {
        let run = self
            .runs
            .iter_mut()
            .find(|run| run.terminal_id == terminal_id && run.status.is_active())?;
        let intentional_signal = signal
            .is_some_and(|signal| signal.contains("Interrupt") || signal.contains("Terminated"));
        run.status = if exit_code == Some(0)
            || intentional_signal
            || run.status == ManagedRunStatus::Stopping
        {
            ManagedRunStatus::Stopped
        } else {
            ManagedRunStatus::Failed
        };
        run.exit_code = exit_code;
        run.stopped_at = Some(now());
        Some(run.clone())
    }
}

pub static RUN_REGISTRY: Lazy<Mutex<RunRegistry>> =
    Lazy::new(|| Mutex::new(RunRegistry::default()));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunEnvironment {
    pub project_id: String,
    pub worktree_id: String,
    pub base_port: Option<u16>,
    pub port_count: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub started_at: u64,
    pub command: String,
}

pub fn reconcile_orphaned_runs(
    registry: &mut RunRegistry,
    inspect: impl Fn(u32) -> Option<ProcessIdentity>,
) -> Vec<u32> {
    let mut to_kill = Vec::new();
    for run in &mut registry.runs {
        if !run.status.is_active() {
            continue;
        }
        let Some(pid) = run.pid else {
            run.status = ManagedRunStatus::Orphaned;
            continue;
        };
        let expected_start = run.process_started_at;
        let expected_command = run.command_fingerprint.as_deref();
        let identity = inspect(pid);
        let strong_match = identity.as_ref().is_some_and(|identity| {
            expected_start == Some(identity.started_at)
                && expected_command.is_some_and(|command| identity.command.contains(command))
        });
        if strong_match {
            run.status = ManagedRunStatus::Stopping;
            to_kill.push(pid);
        } else {
            run.status = ManagedRunStatus::Orphaned;
            run.stopped_at = Some(now());
            run.error = Some("Jean could not safely verify the persisted process identity".into());
        }
    }
    to_kill
}

fn registry_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("managed-runs.json"))
        .map_err(|error| format!("Failed to resolve managed Run state path: {error}"))
}

fn persist_registry(app: &AppHandle) -> Result<(), String> {
    let path = registry_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create managed Run state directory: {error}"))?;
    }
    let registry = RUN_REGISTRY.lock().unwrap().clone();
    let json = serde_json::to_vec_pretty(&registry)
        .map_err(|error| format!("Failed to serialize managed Runs: {error}"))?;
    crate::platform::write_binary_file(&path, &json)
        .map_err(|error| format!("Failed to persist managed Runs: {error}"))
}

fn emit_run(app: &AppHandle, run: &ManagedRun) {
    if let Err(error) = app.emit_all("run:updated", run) {
        log::warn!("Failed to emit run:updated: {error}");
    }
}

fn resolve_context(
    app: &AppHandle,
    worktree_id: &str,
) -> Result<
    (
        crate::projects::types::Project,
        crate::projects::types::Worktree,
        crate::projects::types::JeanConfig,
    ),
    String,
> {
    let data = crate::projects::storage::load_projects_data(app)?;
    let worktree = data
        .find_worktree(worktree_id)
        .cloned()
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;
    let project = data
        .find_project(&worktree.project_id)
        .cloned()
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?;
    let worktree_config = crate::projects::git::read_jean_config(&worktree.path);
    let project_config = crate::projects::git::read_jean_config(&project.path);
    let config = resolve_run_config(worktree_config, project_config);
    Ok((project, worktree, config))
}

/// Run commands may vary with the checked-out branch, but concurrency and port
/// allocation are project-level settings edited from Project Settings. Keep the
/// worktree's scripts while making the project root policy authoritative.
pub(crate) fn resolve_run_config(
    worktree_config: Option<crate::projects::types::JeanConfig>,
    project_config: Option<crate::projects::types::JeanConfig>,
) -> crate::projects::types::JeanConfig {
    let project_policy = project_config
        .as_ref()
        .and_then(|config| config.run_policy.clone());
    let mut config = worktree_config
        .or_else(|| project_config.clone())
        .unwrap_or_default();
    if project_policy.is_some() {
        config.run_policy = project_policy;
    }
    config
}

fn required_port_count(config: &crate::projects::types::JeanConfig, configured: u16) -> u16 {
    let declared = config
        .ports
        .as_ref()
        .map_or(0, |ports| ports.len().min(50) as u16);
    configured.max(declared).clamp(1, 50)
}

fn port_environment_name(label: &str) -> Option<String> {
    let normalized = label
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    (!normalized.is_empty()).then(|| format!("JEAN_PORT_{normalized}"))
}

fn allocated_port_environment(
    config: &crate::projects::types::JeanConfig,
    allocation: &super::run_ports::WorkspacePortAllocation,
) -> Vec<(String, String)> {
    let mut environment = vec![
        ("JEAN_PORT".to_string(), allocation.base_port.to_string()),
        (
            "JEAN_PORT_COUNT".to_string(),
            allocation.port_count.to_string(),
        ),
    ];
    let mut named_variables = std::collections::HashSet::new();
    for (index, port) in config
        .ports
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        if index >= allocation.port_count as usize {
            break;
        }
        let allocated = allocation.base_port + index as u16;
        environment.push((format!("JEAN_PORT_{}", index + 1), allocated.to_string()));
        if let Some(name) = port_environment_name(&port.label) {
            if named_variables.insert(name.clone()) {
                environment.push((name, allocated.to_string()));
            }
        }
    }
    environment
}

fn resolve_declared_ports(
    config: &crate::projects::types::JeanConfig,
    allocation: &super::run_ports::WorkspacePortAllocation,
) -> Vec<crate::projects::types::PortEntry> {
    let declared = config.ports.as_deref().unwrap_or_default();
    if declared.is_empty() {
        return vec![crate::projects::types::PortEntry {
            port: allocation.base_port,
            label: "Run".to_string(),
            host: None,
        }];
    }
    declared
        .iter()
        .take(allocation.port_count as usize)
        .enumerate()
        .map(|(index, port)| crate::projects::types::PortEntry {
            port: allocation.base_port + index as u16,
            label: port.label.clone(),
            host: port.host.clone(),
        })
        .collect()
}

pub async fn start_managed_run(
    app: AppHandle,
    worktree_id: String,
    script_id: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<ManagedRun, String> {
    let (project, worktree, config) = resolve_context(&app, &worktree_id)?;
    let policy = config.effective_run_policy();
    let scripts = config
        .scripts
        .run
        .clone()
        .ok_or_else(|| "No Run script is configured in jean.json".to_string())?
        .into_entries();
    let script = scripts
        .into_iter()
        .find(|script| script.id == script_id)
        .ok_or_else(|| format!("Run script not found: {script_id}"))?;

    let existing = RUN_REGISTRY
        .lock()
        .unwrap()
        .find_active_script(&worktree_id, &script_id)
        .cloned();

    let runs_to_stop = RUN_REGISTRY.lock().unwrap().runs_to_stop_before_start(
        policy.mode,
        &project.id,
        &worktree_id,
        &script_id,
    );
    for run_id in runs_to_stop {
        stop_managed_run(app.clone(), run_id).await?;
    }
    if let Some(existing) = existing {
        return Ok(existing);
    }

    let allocation =
        if policy.port_allocation == crate::projects::types::RunPortAllocation::Workspace {
            Some(super::run_ports::allocate_workspace_ports(
                &app,
                &project.id,
                &worktree.id,
                required_port_count(&config, policy.ports_per_workspace),
            )?)
        } else {
            None
        };

    let run_id = Uuid::new_v4().to_string();
    let mut run = ManagedRun::starting(
        run_id.clone(),
        project.id.clone(),
        worktree.id.clone(),
        terminal_id.clone(),
        script.id,
        script.command.clone(),
        allocation.as_ref().map(|allocation| allocation.base_port),
        allocation
            .as_ref()
            .map_or(0, |allocation| allocation.port_count),
    );
    RUN_REGISTRY.lock().unwrap().insert(run.clone());
    persist_registry(&app)?;
    emit_run(&app, &run);

    let mut environment = vec![
        ("JEAN_WORKSPACE_ID".to_string(), worktree.id.clone()),
        ("JEAN_WORKSPACE_NAME".to_string(), worktree.name.clone()),
        ("JEAN_WORKSPACE_PATH".to_string(), worktree.path.clone()),
        ("JEAN_ROOT_PATH".to_string(), project.path.clone()),
        ("JEAN_PROJECT_ID".to_string(), project.id.clone()),
        ("JEAN_PROJECT_NAME".to_string(), project.name.clone()),
        ("JEAN_RUN_ID".to_string(), run_id.clone()),
    ];
    if let Some(allocation) = allocation.as_ref() {
        environment.extend(allocated_port_environment(&config, allocation));
    }

    match super::pty::spawn_terminal_with_env(
        &app,
        terminal_id,
        worktree.path,
        cols,
        rows,
        Some(script.command),
        None,
        environment,
        Some(run_id.clone()),
    ) {
        Ok(pid) => {
            run.pid = Some(pid);
            if let Some(identity) = inspect_process(pid) {
                run.process_started_at = Some(identity.started_at);
                run.command_fingerprint = Some(identity.command);
            }
            run.status = ManagedRunStatus::Running;
        }
        Err(error) => {
            run.status = ManagedRunStatus::Failed;
            run.error = Some(error.clone());
            run.stopped_at = Some(now());
            RUN_REGISTRY.lock().unwrap().insert(run.clone());
            persist_registry(&app)?;
            emit_run(&app, &run);
            return Err(error);
        }
    }
    RUN_REGISTRY.lock().unwrap().insert(run.clone());
    persist_registry(&app)?;
    emit_run(&app, &run);
    Ok(run)
}

pub async fn stop_managed_run(app: AppHandle, run_id: String) -> Result<ManagedRun, String> {
    let mut run = RUN_REGISTRY
        .lock()
        .unwrap()
        .get(&run_id)
        .cloned()
        .ok_or_else(|| format!("Managed Run not found: {run_id}"))?;
    if !run.status.is_active() {
        return Ok(run);
    }
    run.status = ManagedRunStatus::Stopping;
    RUN_REGISTRY.lock().unwrap().insert(run.clone());
    persist_registry(&app)?;
    emit_run(&app, &run);

    if let Some(pid) = super::registry::terminal_process_id(&run.terminal_id) {
        let process_tree = crate::platform::snapshot_process_tree(pid);
        let _ = crate::platform::terminate_process_tree(pid);
        for _ in 0..50 {
            if process_tree
                .iter()
                .all(|pid| !crate::platform::is_process_alive(*pid))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        crate::platform::force_kill_processes(&process_tree);
    }
    if super::registry::has_terminal(&run.terminal_id) {
        super::pty::kill_terminal(&app, &run.terminal_id)?;
    }

    run.status = ManagedRunStatus::Stopped;
    run.stopped_at = Some(now());
    RUN_REGISTRY.lock().unwrap().insert(run.clone());
    persist_registry(&app)?;
    emit_run(&app, &run);
    Ok(run)
}

pub async fn stop_workspace_runs(
    app: AppHandle,
    worktree_id: String,
) -> Result<Vec<ManagedRun>, String> {
    let run_ids = RUN_REGISTRY
        .lock()
        .unwrap()
        .workspace_runs(&worktree_id)
        .into_iter()
        .filter(|run| run.status.is_active())
        .map(|run| run.id)
        .collect::<Vec<_>>();
    let mut stopped = Vec::new();
    for run_id in run_ids {
        stopped.push(stop_managed_run(app.clone(), run_id).await?);
    }
    Ok(stopped)
}

pub async fn get_project_runs(project_id: String) -> Vec<ManagedRun> {
    RUN_REGISTRY.lock().unwrap().project_runs(&project_id)
}

pub async fn get_workspace_run_environment(
    app: AppHandle,
    worktree_id: String,
) -> Result<RunEnvironment, String> {
    let (project, worktree, config) = resolve_context(&app, &worktree_id)?;
    let policy = config.effective_run_policy();
    let allocation =
        if policy.port_allocation == crate::projects::types::RunPortAllocation::Workspace {
            Some(super::run_ports::allocate_workspace_ports(
                &app,
                &project.id,
                &worktree.id,
                required_port_count(&config, policy.ports_per_workspace),
            )?)
        } else {
            None
        };
    Ok(RunEnvironment {
        project_id: project.id,
        worktree_id: worktree.id,
        base_port: allocation.as_ref().map(|allocation| allocation.base_port),
        port_count: allocation.map_or(0, |allocation| allocation.port_count),
    })
}

pub async fn reallocate_managed_run_ports(
    app: AppHandle,
    worktree_id: String,
) -> Result<super::run_ports::WorkspacePortAllocation, String> {
    let (project, worktree, config) = resolve_context(&app, &worktree_id)?;
    if RUN_REGISTRY
        .lock()
        .unwrap()
        .workspace_runs(&worktree_id)
        .iter()
        .any(|run| run.status.is_active())
    {
        return Err("Stop this workspace's Runs before reallocating ports".to_string());
    }
    let policy = config.effective_run_policy();
    if policy.port_allocation != crate::projects::types::RunPortAllocation::Workspace {
        return Err("Workspace port allocation is not enabled for this project".to_string());
    }
    super::run_ports::reallocate_workspace_ports(
        &app,
        &project.id,
        &worktree.id,
        required_port_count(&config, policy.ports_per_workspace),
    )
}

pub fn get_resolved_ports(
    app: &AppHandle,
    worktree_path: &str,
) -> Vec<crate::projects::types::PortEntry> {
    let worktree_config = crate::projects::git::read_jean_config(worktree_path);
    let fallback = worktree_config
        .as_ref()
        .and_then(|config| config.ports.clone())
        .unwrap_or_default();
    let Ok(data) = crate::projects::storage::load_projects_data(app) else {
        return fallback;
    };
    let Some(worktree) = data
        .worktrees
        .iter()
        .find(|worktree| worktree.path == worktree_path)
    else {
        return fallback;
    };
    let Some(project) = data.find_project(&worktree.project_id) else {
        return fallback;
    };
    let config = resolve_run_config(
        worktree_config,
        crate::projects::git::read_jean_config(&project.path),
    );
    let policy = config.effective_run_policy();
    if policy.port_allocation != crate::projects::types::RunPortAllocation::Workspace {
        return config.ports.unwrap_or_default();
    }
    let Ok(allocation) = super::run_ports::allocate_workspace_ports(
        app,
        &project.id,
        &worktree.id,
        required_port_count(&config, policy.ports_per_workspace),
    ) else {
        return fallback;
    };
    resolve_declared_ports(&config, &allocation)
}

pub(crate) fn teardown_environment(
    app: &AppHandle,
    project: &crate::projects::types::Project,
    worktree: &crate::projects::types::Worktree,
) -> Result<Vec<(String, String)>, String> {
    let mut environment = vec![
        ("JEAN_WORKSPACE_ID".to_string(), worktree.id.clone()),
        ("JEAN_WORKSPACE_NAME".to_string(), worktree.name.clone()),
        ("JEAN_PROJECT_ID".to_string(), project.id.clone()),
        ("JEAN_PROJECT_NAME".to_string(), project.name.clone()),
    ];
    if let Some(allocation) = super::run_ports::get_workspace_ports(app, &project.id, &worktree.id)?
    {
        let config = resolve_run_config(
            crate::projects::git::read_jean_config(&worktree.path),
            crate::projects::git::read_jean_config(&project.path),
        );
        environment.extend(allocated_port_environment(&config, &allocation));
    }
    Ok(environment)
}

pub(crate) fn release_deleted_workspace_ports(
    app: &AppHandle,
    project_id: &str,
    worktree_id: &str,
) {
    if let Err(error) = super::run_ports::release_workspace_ports(app, project_id, worktree_id) {
        log::warn!("Failed to release Run ports for deleted workspace: {error}");
    }
}

pub fn handle_terminal_exit(
    app: &AppHandle,
    terminal_id: &str,
    exit_code: Option<i32>,
    signal: Option<&str>,
) {
    let updated = RUN_REGISTRY
        .lock()
        .unwrap()
        .terminal_exited(terminal_id, exit_code, signal);
    if let Some(run) = updated {
        if let Err(error) = persist_registry(app) {
            log::warn!("Failed to persist exited managed Run: {error}");
        }
        emit_run(app, &run);
    }
}

fn inspect_process(pid: u32) -> Option<ProcessIdentity> {
    #[cfg(unix)]
    {
        let output = crate::platform::silent_command("ps")
            .args(["-p", &pid.to_string(), "-o", "lstart=", "-o", "command="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text.trim();
        let mut parts = line.split_whitespace();
        let start_text = (0..5)
            .filter_map(|_| parts.next())
            .collect::<Vec<_>>()
            .join(" ");
        let command = parts.collect::<Vec<_>>().join(" ");
        let started = chrono::NaiveDateTime::parse_from_str(&start_text, "%a %b %e %T %Y")
            .ok()?
            .and_local_timezone(chrono::Local)
            .single()?
            .timestamp()
            .max(0) as u64;
        Some(ProcessIdentity {
            started_at: started,
            command,
        })
    }
    #[cfg(windows)]
    {
        inspect_windows_process(pid)
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = pid;
        None
    }
}

#[cfg(windows)]
fn inspect_windows_process(pid: u32) -> Option<ProcessIdentity> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let times_ok =
            GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0;
        let mut path = vec![0_u16; 32_768];
        let mut path_len = path.len() as u32;
        let path_ok = QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut path_len) != 0;
        CloseHandle(handle);
        if !times_ok || !path_ok {
            return None;
        }
        let windows_ticks =
            (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        let unix_seconds = windows_ticks
            .checked_div(10_000_000)?
            .checked_sub(11_644_473_600)?;
        path.truncate(path_len as usize);
        Some(ProcessIdentity {
            started_at: unix_seconds,
            command: String::from_utf16_lossy(&path),
        })
    }
}

pub fn cleanup_orphaned_managed_runs(app: &AppHandle) {
    let Ok(path) = registry_path(app) else {
        return;
    };
    if !path.exists() {
        return;
    }
    let loaded = std::fs::read_to_string(&path)
        .ok()
        .and_then(|json| serde_json::from_str::<RunRegistry>(&json).ok());
    let Some(mut registry) = loaded else {
        log::warn!("Managed Run registry is unreadable; leaving processes untouched");
        return;
    };
    for run in &mut registry.runs {
        if run.status.is_active()
            && run
                .pid
                .is_some_and(|pid| !crate::platform::is_process_alive(pid))
        {
            run.status = ManagedRunStatus::Stopped;
            run.stopped_at = Some(now());
            run.error = None;
        }
    }
    let to_kill = reconcile_orphaned_runs(&mut registry, inspect_process);
    for pid in to_kill {
        if let Err(error) = crate::platform::kill_process_tree(pid) {
            log::warn!("Failed to clean orphaned managed Run process {pid}: {error}");
        }
        for run in &mut registry.runs {
            if run.pid == Some(pid) && run.status == ManagedRunStatus::Stopping {
                run.status = ManagedRunStatus::Stopped;
                run.stopped_at = Some(now());
            }
        }
    }
    *RUN_REGISTRY.lock().unwrap() = registry;
    if let Err(error) = persist_registry(app) {
        log::warn!("Failed to persist managed Run recovery: {error}");
    }
}

fn now() -> u64 {
    chrono::Utc::now().timestamp().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::{
        allocated_port_environment, reconcile_orphaned_runs, required_port_count,
        resolve_declared_ports, resolve_run_config, ManagedRun, ManagedRunStatus, ProcessIdentity,
        RunRegistry,
    };
    use crate::projects::types::{JeanConfig, PortEntry, RunPolicyMode, RunPortAllocation};
    use crate::terminal::run_ports::WorkspacePortAllocation;

    fn run(id: &str, project: &str, worktree: &str, script: &str) -> ManagedRun {
        ManagedRun::starting(
            id.into(),
            project.into(),
            worktree.into(),
            format!("terminal-{id}"),
            script.into(),
            format!("command-{script}"),
            None,
            0,
        )
    }

    #[test]
    fn exclusive_start_returns_every_other_active_project_run() {
        let mut registry = RunRegistry::default();
        let mut first = run("one", "project", "alpha", "web");
        first.status = ManagedRunStatus::Running;
        registry.insert(first);

        let to_stop = registry.runs_to_stop_before_start(
            RunPolicyMode::Exclusive,
            "project",
            "beta",
            "worker",
        );

        assert_eq!(to_stop, vec!["one"]);
    }

    #[test]
    fn concurrent_start_does_not_stop_other_workspaces() {
        let mut registry = RunRegistry::default();
        let mut first = run("one", "project", "alpha", "web");
        first.status = ManagedRunStatus::Running;
        registry.insert(first);

        assert!(registry
            .runs_to_stop_before_start(RunPolicyMode::Concurrent, "project", "beta", "web")
            .is_empty());
    }

    #[test]
    fn exclusive_restart_keeps_matching_run_but_stops_other_active_runs() {
        let mut registry = RunRegistry::default();
        let mut matching = run("matching", "project", "alpha", "web");
        matching.status = ManagedRunStatus::Running;
        registry.insert(matching);
        let mut other = run("other", "project", "beta", "worker");
        other.status = ManagedRunStatus::Running;
        registry.insert(other);

        assert_eq!(
            registry.runs_to_stop_before_start(RunPolicyMode::Exclusive, "project", "alpha", "web"),
            vec!["other"]
        );
    }

    #[test]
    fn same_script_in_same_workspace_is_reused() {
        let mut registry = RunRegistry::default();
        let mut first = run("one", "project", "alpha", "web");
        first.status = ManagedRunStatus::Running;
        registry.insert(first);

        assert_eq!(
            registry.find_active_script("alpha", "web").unwrap().id,
            "one"
        );
    }

    #[test]
    fn terminal_exit_marks_clean_stop_or_failure() {
        let mut registry = RunRegistry::default();
        registry.insert(run("clean", "project", "alpha", "web"));
        registry.insert(run("failed", "project", "beta", "web"));

        registry.terminal_exited("terminal-clean", Some(0), None);
        registry.terminal_exited("terminal-failed", Some(2), None);

        assert_eq!(
            registry.get("clean").unwrap().status,
            ManagedRunStatus::Stopped
        );
        assert_eq!(
            registry.get("failed").unwrap().status,
            ManagedRunStatus::Failed
        );
    }

    #[test]
    fn orphan_recovery_only_kills_a_strong_process_identity_match() {
        let mut registry = RunRegistry::default();
        let mut matching = run("matching", "project", "alpha", "web");
        matching.status = ManagedRunStatus::Running;
        matching.pid = Some(42);
        matching.process_started_at = Some(100);
        matching.command_fingerprint = Some("command-web".into());
        registry.insert(matching);

        let kill = reconcile_orphaned_runs(&mut registry, |_| {
            Some(ProcessIdentity {
                started_at: 100,
                command: "shell -c command-web".into(),
            })
        });

        assert_eq!(kill, vec![42]);
    }

    #[test]
    fn orphan_recovery_never_kills_a_reused_pid() {
        let mut registry = RunRegistry::default();
        let mut reused = run("reused", "project", "alpha", "web");
        reused.status = ManagedRunStatus::Running;
        reused.pid = Some(42);
        reused.process_started_at = Some(100);
        reused.command_fingerprint = Some("command-web".into());
        registry.insert(reused);

        let kill = reconcile_orphaned_runs(&mut registry, |_| {
            Some(ProcessIdentity {
                started_at: 200,
                command: "unrelated".into(),
            })
        });

        assert!(kill.is_empty());
        assert_eq!(
            registry.get("reused").unwrap().status,
            ManagedRunStatus::Orphaned
        );
    }

    #[test]
    fn project_policy_overrides_worktree_policy_without_replacing_branch_scripts() {
        let worktree: JeanConfig = serde_json::from_str(
            r#"{
                "scripts": {"run": "branch-command"},
                "runPolicy": {"mode": "concurrent", "portAllocation": "none"}
            }"#,
        )
        .unwrap();
        let project: JeanConfig = serde_json::from_str(
            r#"{
                "scripts": {"run": "root-command"},
                "runPolicy": {
                    "mode": "exclusive",
                    "portAllocation": "workspace",
                    "portsPerWorkspace": 7
                }
            }"#,
        )
        .unwrap();

        let resolved = resolve_run_config(Some(worktree), Some(project));
        let policy = resolved.effective_run_policy();
        let script = resolved.scripts.run.unwrap().into_entries().remove(0);

        assert_eq!(script.command, "branch-command");
        assert_eq!(policy.mode, RunPolicyMode::Exclusive);
        assert_eq!(policy.port_allocation, RunPortAllocation::Workspace);
        assert_eq!(policy.ports_per_workspace, 7);
    }

    #[test]
    fn worktree_policy_is_used_when_project_root_has_no_policy() {
        let worktree: JeanConfig = serde_json::from_str(
            r#"{
                "scripts": {"run": "branch-command"},
                "runPolicy": {"mode": "exclusive", "portAllocation": "workspace"}
            }"#,
        )
        .unwrap();
        let project: JeanConfig =
            serde_json::from_str(r#"{"scripts":{"run":"root-command"}}"#).unwrap();

        let resolved = resolve_run_config(Some(worktree), Some(project));

        assert_eq!(
            resolved.effective_run_policy().mode,
            RunPolicyMode::Exclusive
        );
    }

    #[test]
    fn declared_app_ports_expand_the_allocated_workspace_range() {
        let config = JeanConfig {
            ports: Some(vec![
                PortEntry {
                    port: 3000,
                    label: "Web App".into(),
                    host: None,
                },
                PortEntry {
                    port: 4000,
                    label: "API".into(),
                    host: None,
                },
                PortEntry {
                    port: 5000,
                    label: "Worker".into(),
                    host: None,
                },
            ]),
            ..JeanConfig::default()
        };

        assert_eq!(required_port_count(&config, 2), 3);
        assert_eq!(required_port_count(&config, 10), 10);
    }

    #[test]
    fn declared_ports_map_to_allocated_ports_and_named_environment_variables() {
        let config = JeanConfig {
            ports: Some(vec![
                PortEntry {
                    port: 3000,
                    label: "Web App".into(),
                    host: None,
                },
                PortEntry {
                    port: 4000,
                    label: "API".into(),
                    host: Some("127.0.0.1".into()),
                },
            ]),
            ..JeanConfig::default()
        };
        let allocation = WorkspacePortAllocation {
            project_id: "project".into(),
            worktree_id: "workspace".into(),
            base_port: 55_100,
            port_count: 2,
            allocated_at: 0,
        };

        let resolved = resolve_declared_ports(&config, &allocation);
        let environment = allocated_port_environment(&config, &allocation);

        assert_eq!(resolved[0].port, 55_100);
        assert_eq!(resolved[0].label, "Web App");
        assert_eq!(resolved[1].port, 55_101);
        assert_eq!(resolved[1].host.as_deref(), Some("127.0.0.1"));
        assert!(environment.contains(&("JEAN_PORT".into(), "55100".into())));
        assert!(environment.contains(&("JEAN_PORT_1".into(), "55100".into())));
        assert!(environment.contains(&("JEAN_PORT_WEB_APP".into(), "55100".into())));
        assert!(environment.contains(&("JEAN_PORT_API".into(), "55101".into())));
    }
}
