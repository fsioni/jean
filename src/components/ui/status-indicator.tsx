import { cn } from '@/lib/utils'

export type IndicatorStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'plan_approval'
  | 'input_required'
  | 'permission'
  | 'review'
  | 'completed'
  | 'cancelled'
  | 'crashed'
  | 'scheduled'

export type IndicatorShape = 'circle' | 'square' | 'diamond' | 'ring'

interface StatusIndicatorProps {
  status: IndicatorStatus
  shape?: IndicatorShape
  /** Accessible name describing the status (also used as title fallback). */
  label?: string
  className?: string
}

function resolveShape(
  status: IndicatorStatus,
  shape?: IndicatorShape
): IndicatorShape {
  if (shape) return shape
  switch (status) {
    case 'plan_approval':
      return 'square'
    case 'input_required':
      return 'diamond'
    case 'permission':
      return 'square'
    case 'cancelled':
      return 'ring'
    case 'crashed':
      return 'square'
    case 'scheduled':
      return 'diamond'
    case 'waiting':
      return 'diamond'
    default:
      return 'circle'
  }
}

function shapeClasses(shape: IndicatorShape): string {
  switch (shape) {
    case 'square':
      return 'rounded-sm'
    case 'diamond':
      return 'rounded-sm rotate-45'
    case 'ring':
      return 'rounded-full border-2 border-current bg-transparent'
    case 'circle':
    default:
      return 'rounded-full'
  }
}

export function StatusIndicator({
  status,
  shape,
  label,
  className,
}: StatusIndicatorProps) {
  const resolvedShape = resolveShape(status, shape)
  const shapeClass = shapeClasses(resolvedShape)
  const title = label

  // Running state: CSS border spinner in primary color (black in light, yellow in dark)
  if (status === 'running') {
    return (
      <span
        role="img"
        aria-label={label}
        title={title}
        className={cn(
          'shrink-0 block animate-spin border-2 border-transparent motion-reduce:animate-none',
          // Reduced motion: solid fill instead of spinner so status remains visible
          'motion-reduce:border-0 motion-reduce:bg-current motion-reduce:text-primary',
          'border-t-primary bg-primary/10 forced-colors:border-t-[Highlight]',
          shapeClass,
          className
        )}
      />
    )
  }

  // Static states: filled/outline shapes with distinct colors + shapes
  const colorClass =
    status === 'waiting' ||
    status === 'plan_approval' ||
    status === 'input_required' ||
    status === 'permission'
      ? 'text-warning animate-blink motion-reduce:animate-none forced-colors:text-[Highlight]'
      : status === 'review' || status === 'completed'
        ? 'text-success forced-colors:text-[Highlight]'
        : status === 'crashed'
          ? 'text-destructive forced-colors:text-[Mark]'
          : status === 'scheduled'
            ? 'text-info forced-colors:text-[Highlight]'
            : status === 'cancelled'
              ? 'text-muted-foreground forced-colors:text-[GrayText]'
              : 'text-muted-foreground/50 forced-colors:text-[GrayText]'

  // Ring shape already uses border + transparent fill; others fill with currentColor
  const fillClass = resolvedShape === 'ring' ? '' : 'bg-current'

  return (
    <span
      role="img"
      aria-label={label}
      title={title}
      className={cn(
        'shrink-0 block',
        fillClass,
        shapeClass,
        colorClass,
        className
      )}
    />
  )
}
