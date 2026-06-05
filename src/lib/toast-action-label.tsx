import { Kbd } from '@/components/ui/kbd'
import { isNativeApp } from '@/lib/environment'

export const TOAST_ACTION_SHORTCUT = {
  shortcut: 'alt+enter',
  label:
    typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
      ? '⌥↩'
      : 'Alt+Enter',
} as const

function shouldShowToastActionShortcut(): boolean {
  return (
    isNativeApp() && (typeof window === 'undefined' || window.innerWidth >= 768)
  )
}

export function ToastActionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{children}</span>
      {shouldShowToastActionShortcut() && (
        <Kbd className="h-4 min-w-0 bg-primary-foreground/20 px-1 text-[10px] text-primary-foreground">
          {TOAST_ACTION_SHORTCUT.label}
        </Kbd>
      )}
    </span>
  )
}

export function toastActionLabel(label: React.ReactNode) {
  return <ToastActionLabel>{label}</ToastActionLabel>
}
