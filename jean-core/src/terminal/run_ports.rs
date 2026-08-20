use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::AppHandle;

static PORT_STATE: once_cell::sync::Lazy<Mutex<Option<PortAllocationState>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspacePortAllocation {
    pub project_id: String,
    pub worktree_id: String,
    pub base_port: u16,
    pub port_count: u16,
    pub allocated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortAllocationState {
    #[serde(default = "state_version")]
    pub version: u8,
    #[serde(default)]
    pub allocations: Vec<WorkspacePortAllocation>,
}

fn state_version() -> u8 {
    1
}

impl Default for PortAllocationState {
    fn default() -> Self {
        Self {
            version: state_version(),
            allocations: Vec::new(),
        }
    }
}

impl PortAllocationState {
    pub fn get(&self, project_id: &str, worktree_id: &str) -> Option<&WorkspacePortAllocation> {
        self.allocations.iter().find(|allocation| {
            allocation.project_id == project_id && allocation.worktree_id == worktree_id
        })
    }

    pub fn release(&mut self, project_id: &str, worktree_id: &str) -> bool {
        let before = self.allocations.len();
        self.allocations.retain(|allocation| {
            allocation.project_id != project_id || allocation.worktree_id != worktree_id
        });
        before != self.allocations.len()
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let json = std::fs::read_to_string(path)
            .map_err(|error| format!("Failed to read Run port allocations: {error}"))?;
        serde_json::from_str(&json)
            .map_err(|error| format!("Failed to parse Run port allocations: {error}"))
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create Run state directory: {error}"))?;
        }
        let json = serde_json::to_vec_pretty(self)
            .map_err(|error| format!("Failed to serialize Run port allocations: {error}"))?;
        crate::platform::write_binary_file(path, &json)
            .map_err(|error| format!("Failed to persist Run port allocations: {error}"))
    }
}

pub struct PortAllocator {
    first_port: u16,
    last_port: u16,
    is_available: Arc<dyn Fn(u16) -> bool + Send + Sync>,
}

impl PortAllocator {
    pub fn new(
        first_port: u16,
        last_port: u16,
        is_available: impl Fn(u16) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            first_port,
            last_port,
            is_available: Arc::new(is_available),
        }
    }

    pub fn system() -> Self {
        Self::new(55_000, 64_999, port_is_available)
    }

    pub fn allocate(
        &self,
        state: &mut PortAllocationState,
        project_id: &str,
        worktree_id: &str,
        port_count: u16,
    ) -> Result<WorkspacePortAllocation, String> {
        if let Some(existing) = state.get(project_id, worktree_id) {
            if existing.port_count == port_count {
                return Ok(existing.clone());
            }
            return self.reallocate(state, project_id, worktree_id, port_count);
        }
        self.allocate_excluding(state, project_id, worktree_id, port_count, None)
    }

    pub fn reallocate(
        &self,
        state: &mut PortAllocationState,
        project_id: &str,
        worktree_id: &str,
        port_count: u16,
    ) -> Result<WorkspacePortAllocation, String> {
        let previous = state.get(project_id, worktree_id).cloned();
        state.release(project_id, worktree_id);
        match self.allocate_excluding(
            state,
            project_id,
            worktree_id,
            port_count,
            previous.as_ref().map(|allocation| allocation.base_port),
        ) {
            Ok(allocation) => Ok(allocation),
            Err(error) => {
                if let Some(previous) = previous {
                    state.allocations.push(previous);
                }
                Err(error)
            }
        }
    }

    fn allocate_excluding(
        &self,
        state: &mut PortAllocationState,
        project_id: &str,
        worktree_id: &str,
        port_count: u16,
        excluded_base: Option<u16>,
    ) -> Result<WorkspacePortAllocation, String> {
        if port_count == 0 || self.first_port > self.last_port {
            return Err("Invalid Run port allocation range".to_string());
        }
        let range_len = u32::from(self.last_port) - u32::from(self.first_port) + 1;
        let block_count = range_len / u32::from(port_count);
        if block_count == 0 {
            return Err("Run port block is larger than the allocation range".to_string());
        }

        let start_index = stable_block_index(worktree_id, block_count);
        for offset in 0..block_count {
            let index = (start_index + offset) % block_count;
            let base_u32 = u32::from(self.first_port) + index * u32::from(port_count);
            let Ok(base_port) = u16::try_from(base_u32) else {
                continue;
            };
            if excluded_base == Some(base_port)
                || block_overlaps_allocations(base_port, port_count, &state.allocations)
                || !(0..port_count).all(|port_offset| (self.is_available)(base_port + port_offset))
            {
                continue;
            }
            let allocation = WorkspacePortAllocation {
                project_id: project_id.to_string(),
                worktree_id: worktree_id.to_string(),
                base_port,
                port_count,
                allocated_at: now(),
            };
            state.allocations.push(allocation.clone());
            return Ok(allocation);
        }
        Err(format!(
            "No free block of {port_count} Run ports is available between {} and {}",
            self.first_port, self.last_port
        ))
    }
}

fn now() -> u64 {
    chrono::Utc::now().timestamp().max(0) as u64
}

fn stable_block_index(worktree_id: &str, block_count: u32) -> u32 {
    let digest = Sha256::digest(worktree_id.as_bytes());
    let seed = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    seed % block_count
}

fn block_overlaps_allocations(
    base_port: u16,
    port_count: u16,
    allocations: &[WorkspacePortAllocation],
) -> bool {
    let start = u32::from(base_port);
    let end = start + u32::from(port_count);
    allocations.iter().any(|allocation| {
        let allocated_start = u32::from(allocation.base_port);
        let allocated_end = allocated_start + u32::from(allocation.port_count);
        start < allocated_end && allocated_start < end
    })
}

fn port_is_available(port: u16) -> bool {
    let ipv4 = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port));
    if ipv4.is_err() {
        return false;
    }
    let ipv6 = std::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port));
    ipv6.is_ok()
}

fn state_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("run-ports.json"))
        .map_err(|error| format!("Failed to resolve Run port state path: {error}"))
}

fn with_state<T>(
    app: &AppHandle,
    operation: impl FnOnce(&mut PortAllocationState) -> Result<(T, bool), String>,
) -> Result<T, String> {
    let path = state_path(app)?;
    let mut guard = PORT_STATE.lock().unwrap();
    if guard.is_none() {
        *guard = Some(PortAllocationState::load(&path)?);
    }
    let state = guard.as_mut().expect("Run port state initialized");
    let (result, changed) = operation(state)?;
    if changed {
        state.save(&path)?;
    }
    Ok(result)
}

pub fn allocate_workspace_ports(
    app: &AppHandle,
    project_id: &str,
    worktree_id: &str,
    port_count: u16,
) -> Result<WorkspacePortAllocation, String> {
    with_state(app, |state| {
        let previous = state.get(project_id, worktree_id).cloned();
        let allocation =
            PortAllocator::system().allocate(state, project_id, worktree_id, port_count)?;
        let changed = previous.as_ref() != Some(&allocation);
        Ok((allocation, changed))
    })
}

pub fn reallocate_workspace_ports(
    app: &AppHandle,
    project_id: &str,
    worktree_id: &str,
    port_count: u16,
) -> Result<WorkspacePortAllocation, String> {
    with_state(app, |state| {
        PortAllocator::system()
            .reallocate(state, project_id, worktree_id, port_count)
            .map(|allocation| (allocation, true))
    })
}

pub fn get_workspace_ports(
    app: &AppHandle,
    project_id: &str,
    worktree_id: &str,
) -> Result<Option<WorkspacePortAllocation>, String> {
    with_state(app, |state| {
        Ok((state.get(project_id, worktree_id).cloned(), false))
    })
}

pub fn release_workspace_ports(
    app: &AppHandle,
    project_id: &str,
    worktree_id: &str,
) -> Result<bool, String> {
    with_state(app, |state| {
        let released = state.release(project_id, worktree_id);
        Ok((released, released))
    })
}

#[cfg(test)]
mod tests {
    use super::{PortAllocationState, PortAllocator};
    use std::collections::HashSet;

    fn allocator_with_busy_ports(busy: &[u16]) -> PortAllocator {
        let busy = busy.iter().copied().collect::<HashSet<_>>();
        PortAllocator::new(55_000, 55_099, move |port| !busy.contains(&port))
    }

    #[test]
    fn allocations_are_stable_and_do_not_overlap() {
        let allocator = allocator_with_busy_ports(&[]);
        let mut state = PortAllocationState::default();

        let first = allocator
            .allocate(&mut state, "project", "alpha", 10)
            .unwrap();
        let same = allocator
            .allocate(&mut state, "project", "alpha", 10)
            .unwrap();
        let second = allocator
            .allocate(&mut state, "project", "beta", 10)
            .unwrap();

        assert_eq!(first, same);
        assert_ne!(first.base_port, second.base_port);
        assert!(first.base_port.abs_diff(second.base_port) >= 10);
    }

    #[test]
    fn allocator_skips_a_block_when_any_port_is_busy() {
        let allocator = allocator_with_busy_ports(&[55_003]);
        let mut state = PortAllocationState::default();

        let allocation = allocator
            .allocate(&mut state, "project", "alpha", 10)
            .unwrap();

        assert!(!(allocation.base_port..allocation.base_port + 10).contains(&55_003));
    }

    #[test]
    fn archived_allocations_are_retained_but_deleted_workspaces_are_released() {
        let allocator = allocator_with_busy_ports(&[]);
        let mut state = PortAllocationState::default();
        let original = allocator
            .allocate(&mut state, "project", "alpha", 10)
            .unwrap();

        assert_eq!(state.get("project", "alpha"), Some(&original));
        state.release("project", "alpha");
        assert!(state.get("project", "alpha").is_none());

        let reused = allocator
            .allocate(&mut state, "project", "alpha", 10)
            .unwrap();
        assert_eq!(reused.base_port, original.base_port);
    }

    #[test]
    fn reallocation_replaces_the_previous_block() {
        let allocator = allocator_with_busy_ports(&[]);
        let mut state = PortAllocationState::default();
        let first = allocator
            .allocate(&mut state, "project", "alpha", 10)
            .unwrap();

        let second = allocator
            .reallocate(&mut state, "project", "alpha", 10)
            .unwrap();

        assert_ne!(first.base_port, second.base_port);
        assert_eq!(state.allocations.len(), 1);
        assert_eq!(state.allocations[0], second);
    }

    #[test]
    fn changing_the_configured_block_size_reallocates_the_workspace() {
        let allocator = allocator_with_busy_ports(&[]);
        let mut state = PortAllocationState::default();
        let first = allocator
            .allocate(&mut state, "project", "alpha", 10)
            .unwrap();

        let resized = allocator
            .allocate(&mut state, "project", "alpha", 5)
            .unwrap();

        assert_ne!(first.base_port, resized.base_port);
        assert_eq!(resized.port_count, 5);
        assert_eq!(state.allocations, vec![resized]);
    }

    #[test]
    fn allocation_state_round_trips_through_disk() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("run-ports.json");
        let allocator = allocator_with_busy_ports(&[]);
        let mut state = PortAllocationState::default();
        allocator
            .allocate(&mut state, "project", "alpha", 10)
            .unwrap();

        state.save(&path).unwrap();

        assert_eq!(
            PortAllocationState::load(&path).unwrap().allocations,
            state.allocations
        );
    }
}
