//! Private, verified file artifacts. Agent prose is never a screenshot or PDF.
use super::validation_types::{StepResult, ValidationExecution};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};
const MAX_ARTIFACT_BYTES: u64 = 20 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::super::validation_types::*;
    use super::*;
    fn fixture() -> (tempfile::TempDir, ValidationExecution, StepResult) {
        let dir = tempfile::tempdir().unwrap();
        let e = ValidationExecution::new("p".into(), "w".into(), "r".into(), "t".into(), Some(1));
        let r = StepResult {
            identity: StepIdentity {
                execution_id: e.id.clone(),
                step: ValidationStep::Acceptance,
                attempt_id: uuid::Uuid::new_v4().to_string(),
                input_revision: 0,
            },
            outcome: StepOutcome::Passed,
            commit: "abc".into(),
            requirements: vec![],
            defects: vec![],
            evidence: vec![],
            message: None,
            deployed_commit: None,
        };
        (dir, e, r)
    }
    fn evidence(path: &Path, kind: &str) -> Evidence {
        Evidence {
            id: "capture".into(),
            label: "Capture".into(),
            kind: kind.into(),
            value: path.to_string_lossy().into_owned(),
            commit: "abc".into(),
            stale: false,
        }
    }
    #[test]
    fn pdf_is_copied_privately_and_source_preserved() {
        let (dir, mut e, mut r) = fixture();
        e.transitions.push(Transition {
            revision: 0,
            step: ValidationStep::Acceptance,
            status: ValidationStatus::Running,
            message: "start".into(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        });
        let source = dir.path().join("source.pdf");
        fs::write(&source, b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n").unwrap();
        r.evidence.push(evidence(&source, "pdf"));
        persist_artifacts(dir.path(), &e, &mut r).unwrap();
        let copied = Path::new(&r.evidence[0].value);
        assert_ne!(source, copied);
        assert!(copied.starts_with(
            fs::canonicalize(dir.path())
                .unwrap()
                .join("ai_pipeline/validations")
                .join(&e.id)
                .join("evidence")
        ));
        assert_eq!(fs::read(copied).unwrap(), fs::read(&source).unwrap());
        assert!(!r.evidence[0].stale);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(copied).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn genuine_png_is_decoded_and_persisted() {
        let (dir, mut e, mut r) = fixture();
        e.transitions.push(Transition {
            revision: 0,
            step: ValidationStep::Acceptance,
            status: ValidationStatus::Running,
            message: "start".into(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        });
        let source = dir.path().join("capture.png");
        image::RgbImage::new(2, 2).save(&source).unwrap();
        r.evidence.push(evidence(&source, "screenshot"));
        persist_artifacts(dir.path(), &e, &mut r).unwrap();
        assert!(r.evidence[0].value.ends_with(".png"));
        assert!(!r.evidence[0].stale);
    }
    #[test]
    fn image_header_without_real_image_is_rejected() {
        assert!(file_extension(b"\x89PNG\r\n\x1a\n", "screenshot").is_err());
        assert!(file_extension(b"\xff\xd8\xff", "screenshot").is_err());
        assert!(file_extension(b"RIFF0000WEBP", "screenshot").is_err());
    }
    #[test]
    fn capture_older_than_attempt_is_rejected() {
        let (dir, mut e, mut r) = fixture();
        e.transitions.push(Transition {
            revision: 0,
            step: ValidationStep::Acceptance,
            status: ValidationStatus::Running,
            message: "start".into(),
            timestamp: (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339(),
        });
        let source = dir.path().join("capture.png");
        image::RgbImage::new(2, 2).save(&source).unwrap();
        r.evidence.push(evidence(&source, "screenshot"));
        assert!(persist_artifacts(dir.path(), &e, &mut r).is_err());
    }
    #[test]
    fn textual_capture_and_invalid_signature_are_rejected() {
        let (dir, e, mut r) = fixture();
        r.evidence.push(evidence(
            Path::new("https://example.invalid/a.png"),
            "screenshot",
        ));
        assert!(persist_artifacts(dir.path(), &e, &mut r).is_err());
        let source = dir.path().join("fake.png");
        fs::write(&source, b"I captured this screen").unwrap();
        r.evidence[0].value = source.to_string_lossy().into_owned();
        assert!(persist_artifacts(dir.path(), &e, &mut r).is_err());
    }
    #[test]
    fn oversized_file_is_rejected_without_reading_it() {
        let (dir, e, mut r) = fixture();
        let source = dir.path().join("large.pdf");
        let file = fs::File::create(&source).unwrap();
        file.set_len(MAX_ARTIFACT_BYTES + 1).unwrap();
        r.evidence.push(evidence(&source, "pdf"));
        assert!(persist_artifacts(dir.path(), &e, &mut r).is_err());
    }
    #[test]
    fn absent_attempt_timestamp_never_claims_freshness() {
        let (dir, e, mut r) = fixture();
        let source = dir.path().join("source.pdf");
        fs::write(&source, b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n").unwrap();
        r.evidence.push(evidence(&source, "pdf"));
        persist_artifacts(dir.path(), &e, &mut r).unwrap();
        assert!(r.evidence[0].stale);
    }
    #[test]
    fn path_outside_authorized_roots_is_rejected() {
        assert!(!authorized_path(
            Path::new("/Users/example/private/secrets.png"),
            Path::new("/private/var/app"),
            Path::new("/private/tmp")
        ));
    }
}

fn authorized_path(source: &Path, app_data: &Path, temporary: &Path) -> bool {
    source.starts_with(app_data)
        || source.starts_with(temporary)
        || fs::canonicalize("/tmp").is_ok_and(|root| source.starts_with(root))
}
fn file_extension(bytes: &[u8], kind: &str) -> Result<&'static str, String> {
    if bytes.starts_with(b"%PDF-") {
        if kind == "screenshot" || !bytes.windows(5).rev().take(1024).any(|w| w == b"%%EOF") {
            return Err("Invalid PDF artifact signature or kind".into());
        }
        return Ok("pdf");
    }
    if kind == "pdf" {
        return Err("PDF artifact has no PDF signature".into());
    }
    let (extension, format) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("png", image::ImageFormat::Png)
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        ("jpg", image::ImageFormat::Jpeg)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        ("webp", image::ImageFormat::WebP)
    } else {
        return Err("Artifact is not a supported PNG, JPEG, WebP or PDF".into());
    };
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| format!("Invalid image artifact: {e}"))?;
    Ok(extension)
}
fn private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    if fs::canonicalize(path).map_err(|e| e.to_string())? != path {
        return Err("Artifact directory contains a symbolic link".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
/// Copies genuine artifacts into private app storage; source files are never changed.
/// An unverifiable creation time marks evidence stale rather than inventing freshness.
pub fn persist_artifacts(
    app_data: &Path,
    execution: &ValidationExecution,
    result: &mut StepResult,
) -> Result<(), String> {
    if result.identity.execution_id != execution.id {
        return Err("Artifact result belongs to another execution".into());
    }
    uuid::Uuid::parse_str(&execution.id).map_err(|_| "Invalid artifact execution id")?;
    let root = fs::canonicalize(app_data)
        .map_err(|e| format!("Private app-data directory unavailable: {e}"))?;
    let temporary = fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
    let start = execution
        .transitions
        .iter()
        .find(|t| t.revision == result.identity.input_revision && t.step == result.identity.step)
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(&t.timestamp).ok())
        .map(SystemTime::from);
    let mut prepared: Vec<(usize, Vec<u8>, &'static str, bool)> = vec![];
    for (index, evidence) in result.evidence.iter().enumerate() {
        if !matches!(evidence.kind.as_str(), "screenshot" | "pdf" | "artifact") {
            continue;
        }
        let path = Path::new(&evidence.value);
        if !path.is_absolute() {
            return Err(format!(
                "Artifact {} must be an absolute local file path",
                evidence.id
            ));
        }
        let source = fs::canonicalize(path)
            .map_err(|e| format!("Artifact {} unavailable: {e}", evidence.id))?;
        if !authorized_path(&source, &root, &temporary) {
            return Err(format!(
                "Artifact {} outside private app data or temporary directory",
                evidence.id
            ));
        }
        let file = fs::File::open(&source).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ARTIFACT_BYTES {
            return Err(format!(
                "Artifact {} is not a regular file within 20 MiB",
                evidence.id
            ));
        }
        let current = fs::metadata(&source).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.dev() != current.dev() || metadata.ino() != current.ino() {
                return Err("Artifact changed while opening it".into());
            }
        }
        #[cfg(not(unix))]
        if metadata.len() != current.len() {
            return Err("Artifact changed while opening it".into());
        }
        let mut bytes = vec![];
        file.take(MAX_ARTIFACT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_ARTIFACT_BYTES || bytes.len() as u64 != metadata.len() {
            return Err("Artifact changed or exceeds size limit".into());
        }
        let extension = file_extension(&bytes, &evidence.kind)?;
        let fresh = start
            .zip(metadata.modified().ok())
            .is_some_and(|(start, modified)| {
                modified
                    .checked_add(std::time::Duration::from_secs(2))
                    .is_some_and(|t| t >= start)
            });
        if start.is_some() && !fresh {
            return Err(format!(
                "Artifact {} predates the current attempt or timestamp cannot be verified",
                evidence.id
            ));
        }
        prepared.push((index, bytes, extension, evidence.stale || !fresh));
    }
    if prepared.is_empty() {
        return Ok(());
    }
    let validations = root.join("ai_pipeline/validations");
    private_directory(&validations)?;
    let execution_dir = validations.join(&execution.id);
    private_directory(&execution_dir)?;
    let destination = execution_dir.join("evidence");
    private_directory(&destination)?;
    if fs::canonicalize(&destination).map_err(|e| e.to_string())? != destination {
        return Err("Artifact destination contains a symbolic link".into());
    }
    let mut copied: Vec<(usize, PathBuf, bool)> = vec![];
    let write_result = (|| -> Result<(), String> {
        for (index, bytes, extension, stale) in prepared {
            let name = uuid::Uuid::new_v4().to_string();
            let target = destination.join(format!("{name}.{extension}"));
            let temporary = destination.join(format!(".{name}.tmp"));
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let written = (|| -> Result<(), String> {
                let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| e.to_string())?;
                fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
                Ok(())
            })();
            if let Err(error) = written {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            copied.push((index, target, stale));
        }
        #[cfg(unix)]
        fs::File::open(&destination)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = write_result {
        for (_, path, _) in copied {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    for (index, path, stale) in copied {
        result.evidence[index].value = path.to_string_lossy().into_owned();
        result.evidence[index].stale = stale;
    }
    Ok(())
}
