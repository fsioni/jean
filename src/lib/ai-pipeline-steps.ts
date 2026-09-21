import { toast } from 'sonner'
import type { StepResult } from '@/types/ai-pipeline'

/**
 * Report the per-step outcome of a resume/finish action in a single toast.
 * Success when every step is ok, otherwise a warning that keeps each step's
 * individual outcome visible (one step may fail while another succeeds).
 */
export function reportSteps(
  toastId: string | number,
  label: string,
  steps: StepResult[]
) {
  const line = steps.map(s => `${s.ok ? '✓' : '✗'} ${s.message}`).join('  ·  ')
  if (steps.every(s => s.ok)) {
    toast.success(`${label} — ${line}`, { id: toastId })
  } else {
    toast.warning(`${label} — ${line}`, { id: toastId })
  }
}
