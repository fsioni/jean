import { cn } from '@/lib/utils'

export function getWorktreeLabelContainerClassName() {
  return cn(
    'flex w-full flex-wrap justify-start gap-1 pt-1',
    'sm:ml-auto sm:w-auto sm:max-w-[45%] sm:justify-end sm:self-start sm:shrink-0 sm:pt-0'
  )
}
