import { Suspense, lazy, type CSSProperties } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { SidebarWidthProvider } from './SidebarWidthContext'

const LeftSideBar = lazy(() =>
  import('./LeftSideBar').then(mod => ({
    default: mod.LeftSideBar,
  }))
)

interface MobileLeftSidebarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  width: number
}

/**
 * Mobile left sidebar as an overlay drawer.
 * Does not shift the main layout; tapping the dimmed backdrop closes it.
 */
export function MobileLeftSidebar({
  open,
  onOpenChange,
  width,
}: MobileLeftSidebarProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="bg-sidebar text-sidebar-foreground w-[min(85vw,var(--mobile-sidebar-width))] gap-0 border-r p-0 sm:max-w-[min(85vw,var(--mobile-sidebar-width))]"
        style={
          {
            '--mobile-sidebar-width': `${width}px`,
          } as CSSProperties
        }
        data-testid="mobile-left-sidebar"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Projects</SheetTitle>
          <SheetDescription>
            Navigate projects and worktrees. Tap the dimmed area to close.
          </SheetDescription>
        </SheetHeader>
        <SidebarWidthProvider value={width}>
          <div className="h-full w-full overflow-hidden">
            <Suspense fallback={null}>
              <LeftSideBar />
            </Suspense>
          </div>
        </SidebarWidthProvider>
      </SheetContent>
    </Sheet>
  )
}
