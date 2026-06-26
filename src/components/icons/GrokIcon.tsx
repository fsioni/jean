import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

export const GrokIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Grok"
      {...props}
    >
      <path d="M12 3 4.5 7.5v9L12 21l7.5-4.5v-9L12 3Z" />
      <path d="m8.5 10.5 3.5-2 3.5 2v4L12 16.5l-3.5-2v-4Z" />
      <path d="M12 8.5V3" />
      <path d="M15.5 10.5 19.5 8" />
      <path d="M8.5 14.5 4.5 17" />
    </svg>
  )
)

GrokIcon.displayName = 'GrokIcon'
