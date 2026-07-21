const MIN_CANVAS_STATUS_REFRESH_SECONDS = 60

export function getCanvasStatusRefreshMs(
  gitPollIntervalSeconds?: number | null
): number {
  return (
    Math.max(
      gitPollIntervalSeconds ?? MIN_CANVAS_STATUS_REFRESH_SECONDS,
      MIN_CANVAS_STATUS_REFRESH_SECONDS
    ) * 1000
  )
}
