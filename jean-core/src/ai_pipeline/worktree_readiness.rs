use std::time::Duration;

/// Checkout returns a pending record before its background setup is persisted.
pub(super) async fn wait_until_ready<T>(
    mut load: impl FnMut() -> Result<Option<T>, String>,
    timeout: Duration,
    interval: Duration,
) -> Result<T, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(worktree) = load()? {
            return Ok(worktree);
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("La création du worktree n'est pas terminée. Attends sa disponibilité puis lance la validation depuis son suivi, sans récupérer à nouveau le ticket.".into());
        }
        tokio::time::sleep(interval.min(remaining)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn waits_for_background_checkout_to_be_persisted() {
        let mut reads = 0;
        let result = wait_until_ready(
            || {
                reads += 1;
                Ok((reads == 3).then_some("ready"))
            },
            Duration::from_secs(1),
            Duration::from_millis(1),
        )
        .await;
        assert_eq!(result.unwrap(), "ready");
        assert_eq!(reads, 3);
    }

    #[tokio::test]
    async fn propagates_project_mismatch_without_retrying() {
        let result = wait_until_ready::<()>(
            || Err("Worktree lié à un autre projet".into()),
            Duration::from_secs(1),
            Duration::from_millis(1),
        )
        .await;
        assert_eq!(result.unwrap_err(), "Worktree lié à un autre projet");
    }

    #[tokio::test]
    async fn stops_when_background_creation_never_completes() {
        let result = wait_until_ready::<()>(
            || Ok(None),
            Duration::from_millis(2),
            Duration::from_millis(1),
        )
        .await;
        assert!(result.unwrap_err().contains("création"));
    }
}
