//! Atomic private execution snapshots. Caller holds VALIDATION_LOCK through read/modify/write.
use super::validation_types::ValidationExecution;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
pub static VALIDATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Debug, Clone)]
pub struct ValidationStore {
    root: PathBuf,
}
impl ValidationStore {
    pub fn new(app_data: impl AsRef<Path>) -> Self {
        Self {
            root: app_data.as_ref().join("ai_pipeline/validations"),
        }
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid validation id".to_string())?;
        Ok(self.root.join(id).join("state.json"))
    }
    pub fn get(&self, id: &str) -> Result<Option<ValidationExecution>, String> {
        let path = self.path(id)?;
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("Read private validation: {e}")),
        };
        let execution: ValidationExecution =
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid validation state: {e}"))?;
        if execution.schema_version != 1 || execution.id != id {
            return Err("Unsupported or mismatched validation state".into());
        }
        Ok(Some(execution))
    }
    pub fn list(&self) -> Result<Vec<ValidationExecution>, String> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(format!("List private validations: {e}")),
        };
        let mut executions = vec![];
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if uuid::Uuid::parse_str(&id).is_err() {
                continue;
            }
            if let Some(execution) = self.get(&id)? {
                executions.push(execution);
            }
        }
        executions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(executions)
    }
    pub fn find_active_for_worktree(
        &self,
        worktree_id: &str,
    ) -> Result<Option<ValidationExecution>, String> {
        Ok(self
            .list()?
            .into_iter()
            .find(|e| e.worktree_id == worktree_id && e.is_active()))
    }
    pub fn save(&self, execution: &ValidationExecution) -> Result<(), String> {
        let path = self.path(&execution.id)?;
        let dir = path.parent().ok_or("Invalid validation path")?;
        fs::create_dir_all(dir).map_err(|e| format!("Create private validation directory: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let temporary = dir.join(format!(".state-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let bytes = serde_json::to_vec_pretty(execution).map_err(|e| e.to_string())?;
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            fs::rename(&temporary, &path)
                .map_err(|e| format!("Replace private validation state: {e}"))?;
            #[cfg(unix)]
            fs::File::open(dir)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_roundtrips_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let store = ValidationStore::new(dir.path());
        let mut e = ValidationExecution::new("p".into(), "w".into(), "r".into(), "t".into(), None);
        store.save(&e).unwrap();
        e.revision = 2;
        store.save(&e).unwrap();
        assert_eq!(store.get(&e.id).unwrap().unwrap().revision, 2);
        assert!(store.get("../config").is_err());
        assert_eq!(store.list().unwrap().len(), 1);
    }
    #[test]
    fn corrupt_snapshot_is_not_silently_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let store = ValidationStore::new(dir.path());
        let e = ValidationExecution::new("p".into(), "w".into(), "r".into(), "t".into(), None);
        store.save(&e).unwrap();
        fs::write(store.path(&e.id).unwrap(), "broken").unwrap();
        assert!(store.list().is_err());
    }
}
