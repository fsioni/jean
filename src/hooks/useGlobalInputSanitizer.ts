import { useEffect } from 'react'
import {
  isSanitizableTextControl,
  sanitizeTextControlValue,
} from '@/lib/input-sanitization'

export function useGlobalInputSanitizer() {
  useEffect(() => {
    const handleInput = (event: Event) => {
      if (!isSanitizableTextControl(event.target)) return

      const result = sanitizeTextControlValue(event.target)
      if (result.sanitized && import.meta.env.DEV) {
        console.warn(
          '[InputSanitizer] Stripped control chars from input:',
          result.removed
        )
      }
    }

    document.addEventListener('input', handleInput, { capture: true })
    return () =>
      document.removeEventListener('input', handleInput, { capture: true })
  }, [])
}
