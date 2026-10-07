/** Isolated backend fixture report; never a live validation execution. */
export interface ValidationLabScenario {
  id: string
  label: string
  passed: boolean
  summary: string
  checks: { label: string; passed: boolean }[]
  transitions: { step: string; status: string; message: string }[]
  execution?: unknown
}
export interface ValidationLabReport {
  scenarios: ValidationLabScenario[]
  passedCount: number
  totalCount: number
  isolated: true
}
