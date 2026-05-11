import { Bot, Loader2, Rabbit } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useCodeRabbitCliStatus } from '@/services/coderabbit-cli'
import { cn } from '@/lib/utils'

interface ReviewMethodModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAiReview: () => void
  onCodeRabbitReview: () => void
}

export function ReviewMethodModal({
  open,
  onOpenChange,
  onAiReview,
  onCodeRabbitReview,
}: ReviewMethodModalProps) {
  const { data: coderabbitStatus, isLoading } = useCodeRabbitCliStatus({
    enabled: open,
  })
  const codeRabbitReady = Boolean(coderabbitStatus?.installed)

  const choose = (handler: () => void) => {
    onOpenChange(false)
    handler()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(360px,calc(100vw-32px))] gap-3 p-4 sm:max-w-[360px]">
        <DialogHeader className="space-y-1 pr-6">
          <DialogTitle className="text-base font-semibold">
            Review with
          </DialogTitle>
          <DialogDescription className="text-xs leading-5">
            Choose the reviewer for this worktree.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <ReviewChoice
            icon={<Bot className="size-4" />}
            title="Jean"
            subtitle="Uses your configured review backend"
            badge="Default"
            onClick={() => choose(onAiReview)}
          />

          <ReviewChoice
            icon={
              isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Rabbit className="size-4" />
              )
            }
            title="CodeRabbit"
            subtitle={
              codeRabbitReady
                ? 'Runs coderabbit review'
                : 'Install or select in Settings'
            }
            disabled={isLoading || !codeRabbitReady}
            onClick={() => choose(onCodeRabbitReview)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ReviewChoice({
  icon,
  title,
  subtitle,
  badge,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  badge?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 py-2.5 text-left transition-colors',
        'hover:border-border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-muted/25'
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium leading-none">
          {title}
          {badge && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      </span>
    </button>
  )
}
