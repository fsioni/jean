import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

export const ClickUpIcon = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M2 18.44 5.7 15.6c1.96 2.56 4.05 3.74 6.38 3.74 2.32 0 4.35-1.16 6.22-3.7L22 18.51c-2.7 3.68-6.06 5.62-9.92 5.62-3.85 0-7.24-1.93-10.08-5.69Z" />
      <path d="M12.06 5.39 5.47 11.07 3.07 8.3 12.07 .53l8.94 7.78-2.41 2.76-6.54-5.68Z" />
    </svg>
  )
)

ClickUpIcon.displayName = 'ClickUpIcon'
