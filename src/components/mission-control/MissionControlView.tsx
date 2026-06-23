import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Hourglass,
  Loader2,
  RefreshCw,
  Rocket,
  Search,
  XCircle,
  ListFilter,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUIStore } from '@/store/ui-store'
import { MissionControlRow } from './MissionControlRow'
import { useMissionControlRows } from './useMissionControlRows'

/** Status filter chips — meaning carried by icon shape + label (colorblind-safe). */
const STATUS_FILTERS: {
  key: string
  label: string
  icon: ReactNode
}[] = [
  { key: 'all', label: 'Tous', icon: <ListFilter className="size-3.5" /> },
  { key: 'FAILURE', label: 'Échecs', icon: <XCircle className="size-3.5" /> },
  {
    key: 'BUILDING',
    label: 'En cours',
    icon: <Loader2 className="size-3.5" />,
  },
  { key: 'QUEUED', label: 'En file', icon: <Hourglass className="size-3.5" /> },
  {
    key: 'SUCCESS',
    label: 'OK',
    icon: <CheckCircle2 className="size-3.5" />,
  },
]

/**
 * Full-page Jenkins "Mission Control": every PR-linked worktree across every
 * project, sorted with failures first, with re-run / preview / open actions.
 * Designed to replace a permanently-open Jenkins tab.
 *
 * Consumes the poller-fed cache only (`useMissionControlRows`) — it does not add
 * a second poll loop. Pokes the backend poller on mount + on the refresh button
 * so opening the view gets fresh data quickly.
 */
export function MissionControlView() {
  const { rows, jenkinsProjectCount, failureCount, isLoading } =
    useMissionControlRows()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const close = useCallback(() => {
    useUIStore.getState().setMissionControlOpen(false)
  }, [])

  const poke = useCallback(() => {
    invoke('poke_jenkins_poll', {}).catch(error => {
      logger.debug('poke_jenkins_poll failed', { error })
    })
  }, [])

  // Nudge the poller for fresh data on open.
  useEffect(() => {
    poke()
  }, [poke])

  // Esc closes the view (unless typing in the search box / another input).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      close()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [close])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(row => {
      if (
        statusFilter !== 'all' &&
        row.status?.overallStatus !== statusFilter
      ) {
        return false
      }
      if (!q) return true
      return (
        row.worktree.name.toLowerCase().includes(q) ||
        row.project.name.toLowerCase().includes(q) ||
        row.worktree.branch.toLowerCase().includes(q) ||
        row.prId.includes(q)
      )
    })
  }, [rows, search, statusFilter])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background font-sans">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          title="Retour"
          aria-label="Retour"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Rocket className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-foreground">
            Mission Control
          </h1>
          <p className="text-xs text-muted-foreground">
            {rows.length} PR
            {failureCount > 0 && (
              <span className="text-red-600 dark:text-red-400">
                {' · '}
                {failureCount} en échec
              </span>
            )}
          </p>
        </div>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={poke}
            title="Forcer un rafraîchissement Jenkins"
          >
            <RefreshCw className="size-3.5" />
            <span className="hidden sm:inline">Rafraîchir</span>
          </Button>
        </div>
      </div>

      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher (projet, worktree, branche, PR#)…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map(f => (
            <Tooltip key={f.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setStatusFilter(f.key)}
                  className={cn(
                    'inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors',
                    statusFilter === f.key
                      ? 'border-foreground/30 bg-muted text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-muted/60'
                  )}
                >
                  {f.icon}
                  {f.label}
                </button>
              </TooltipTrigger>
              <TooltipContent>Filtrer : {f.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* Body */}
      <ScrollArea className="min-h-0 flex-1">
        {jenkinsProjectCount === 0 ? (
          <EmptyState
            title="Aucun projet Jenkins configuré"
            hint="Configurez Jenkins dans les réglages d'un projet (URL, utilisateur, token) pour voir vos pipelines ici."
          />
        ) : isLoading && rows.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Chargement des worktrees…
          </div>
        ) : filteredRows.length === 0 ? (
          <EmptyState
            title={
              rows.length === 0
                ? 'Aucune PR active'
                : 'Aucun résultat pour ce filtre'
            }
            hint={
              rows.length === 0
                ? 'Les worktrees liés à une PR apparaîtront ici dès que Jenkins aura un statut.'
                : 'Ajustez la recherche ou le filtre de statut.'
            }
          />
        ) : (
          <div>
            {filteredRows.map(row => (
              <MissionControlRow key={row.worktree.id} row={row} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-16 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

export default MissionControlView
