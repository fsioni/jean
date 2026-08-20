import { useState } from 'react'
import { FileCode2, Plus, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useProjectsStore } from '@/store/projects-store'
import {
  useProjects,
  useSaveJeanConfig,
  type RunPolicy,
} from '@/services/projects'
import { usePreferences, usePatchPreferences } from '@/services/preferences'

export function JeanConfigWizard() {
  const open = useProjectsStore(s => s.jeanConfigWizardOpen)

  if (!open) return null

  return <JeanConfigWizardContent />
}

function JeanConfigWizardContent() {
  const { jeanConfigWizardProjectId, closeJeanConfigWizard } =
    useProjectsStore()
  const { data: projects = [] } = useProjects()
  const project = projects.find(p => p.id === jeanConfigWizardProjectId)

  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const saveConfig = useSaveJeanConfig()

  const [setupScript, setSetupScript] = useState('')
  const [teardownScript, setTeardownScript] = useState('')
  const [runScripts, setRunScripts] = useState<{ id: string; value: string }[]>(
    () => [{ id: crypto.randomUUID(), value: '' }]
  )
  const [ports, setPorts] = useState<
    { id: string; port: string; label: string; host: string }[]
  >([])
  const [runMode, setRunMode] = useState<RunPolicy['mode']>('concurrent')
  const [portAllocation, setPortAllocation] =
    useState<RunPolicy['portAllocation']>('none')
  const [portsPerWorkspace, setPortsPerWorkspace] = useState('10')

  const markSeen = () => {
    if (preferences && !preferences.has_seen_jean_config_wizard) {
      patchPreferences.mutate({ has_seen_jean_config_wizard: true })
    }
  }

  const handleSave = async () => {
    if (!project?.path) return

    const filtered: string[] = []
    for (const s of runScripts) {
      if (s.value.trim()) filtered.push(s.value)
    }
    let run: string | string[] | null = null
    if (filtered.length === 1) run = filtered[0] ?? null
    else if (filtered.length > 1) run = filtered

    const validPorts = ports.flatMap(p => {
      if (!p.port.trim() || !p.label.trim()) return []
      const port = Number(p.port)
      if (isNaN(port) || port <= 0 || port > 65535) return []
      return [
        {
          port,
          label: p.label.trim(),
          host: p.host.trim() || undefined,
        },
      ]
    })
    const requestedPortCount = Number(portsPerWorkspace)
    const portCount = Math.max(
      Math.min(validPorts.length, 50),
      Math.max(
        1,
        Math.min(
          50,
          Number.isFinite(requestedPortCount)
            ? Math.round(requestedPortCount)
            : 10
        )
      )
    )
    const runPolicy =
      runMode !== 'concurrent' || portAllocation !== 'none'
        ? {
            mode: runMode,
            portAllocation,
            portsPerWorkspace: portCount,
          }
        : null

    await saveConfig.mutateAsync({
      projectPath: project.path,
      config: {
        scripts: {
          setup: setupScript.trim() || null,
          teardown: teardownScript.trim() || null,
          run,
        },
        ports: validPorts.length > 0 ? validPorts : null,
        runPolicy,
      },
    })

    markSeen()
    closeJeanConfigWizard()
  }

  const handleSkip = () => {
    markSeen()
    closeJeanConfigWizard()
  }

  const hasContent =
    setupScript.trim() ||
    teardownScript.trim() ||
    runScripts.some(s => s.value.trim()) ||
    ports.some(p => p.port.trim() && p.label.trim()) ||
    runMode !== 'concurrent' ||
    portAllocation !== 'none'

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) handleSkip()
      }}
    >
      <DialogContent className="!fixed !inset-0 !h-dvh !w-screen !max-w-none !max-h-none !translate-x-0 !translate-y-0 flex flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:!inset-auto sm:!top-[50%] sm:!left-[50%] sm:!h-auto sm:!max-h-[90dvh] sm:!w-full sm:!max-w-md sm:!translate-x-[-50%] sm:!translate-y-[-50%] sm:rounded-lg sm:border sm:shadow-lg [&>[data-slot=dialog-close]]:top-[calc(env(safe-area-inset-top)+1rem)] sm:[&>[data-slot=dialog-close]]:top-4">
        <DialogHeader className="shrink-0 border-b px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pr-14 pb-4 text-left sm:border-b-0 sm:px-6 sm:pt-6 sm:pb-0">
          <DialogTitle>Configure Automation</DialogTitle>
          <DialogDescription>
            {project?.name
              ? `Set up automation scripts for ${project.name}`
              : 'Set up automation scripts for your project'}
          </DialogDescription>
        </DialogHeader>

        <div
          data-testid="jean-config-wizard-scroll"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
        >
          {/* Education callout */}
          <div className="flex gap-3 rounded-lg border border-border/50 bg-muted/30 p-3">
            <FileCode2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                Jean uses a{' '}
                <code className="text-foreground/80">jean.json</code> file in
                your project root to automate repetitive tasks:
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>
                  <strong>Setup</strong> runs automatically when a new worktree
                  is created (e.g. installing dependencies)
                </li>
                <li>
                  <strong>Teardown</strong> runs before a worktree is
                  deleted/archived (e.g. stopping services)
                </li>
                <li>
                  <strong>Run</strong> launches your dev server via the run
                  command, optionally with one allocated port range per
                  workspace
                </li>
              </ul>
              <div className="space-y-0.5 pt-1">
                <p>
                  <code className="text-foreground/80">
                    $JEAN_WORKSPACE_PATH
                  </code>
                  {' — worktree directory'}
                </p>
                <p>
                  <code className="text-foreground/80">$JEAN_ROOT_PATH</code>
                  {' — repository root'}
                </p>
                <p>
                  <code className="text-foreground/80">$JEAN_BRANCH</code>
                  {' — branch name'}
                </p>
                <p>
                  <code className="text-foreground/80">$JEAN_PORT</code>
                  {' — allocated base port when enabled'}
                </p>
                <p>
                  <code className="text-foreground/80">$JEAN_PORT_COUNT</code>
                  {' — allocated range size'}
                </p>
              </div>
            </div>
          </div>

          {/* Setup script */}
          <div className="space-y-1.5">
            <Label htmlFor="wizard-setup-script" className="text-sm">
              Setup Script
            </Label>
            <Input
              id="wizard-setup-script"
              placeholder="e.g. npm install"
              value={setupScript}
              onChange={e => setSetupScript(e.target.value)}
              className="font-mono text-base md:text-sm"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Runs after each new worktree is created
            </p>
          </div>

          {/* Teardown script */}
          <div className="space-y-1.5">
            <Label htmlFor="wizard-teardown-script" className="text-sm">
              Teardown Script
            </Label>
            <Input
              id="wizard-teardown-script"
              placeholder="e.g. docker compose down"
              value={teardownScript}
              onChange={e => setTeardownScript(e.target.value)}
              className="font-mono text-base md:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Runs before each worktree is deleted
            </p>
          </div>

          {/* Run script(s) */}
          <div className="space-y-1.5">
            <Label className="text-sm">Run Script</Label>
            {runScripts.map((entry, i) => (
              <div key={entry.id} className="flex items-center gap-1">
                <Input
                  placeholder="e.g. npm run dev"
                  value={entry.value}
                  onChange={e => {
                    const next = [...runScripts]
                    next[i] = { ...entry, value: e.target.value }
                    setRunScripts(next)
                  }}
                  className="font-mono text-base md:text-sm"
                />
                {runScripts.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() =>
                      setRunScripts(runScripts.filter(s => s.id !== entry.id))
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-11 text-xs sm:h-7"
              onClick={() =>
                setRunScripts([
                  ...runScripts,
                  { id: crypto.randomUUID(), value: '' },
                ])
              }
            >
              <Plus className="mr-1 h-3 w-3" />
              Add command
            </Button>
            <p className="text-xs text-muted-foreground">
              Launches your dev environment in the terminal
            </p>
          </div>

          {/* Run management */}
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <div>
              <Label className="text-sm">Run Management</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Control project-wide concurrency and optional per-workspace port
                allocation.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wizard-run-mode" className="text-xs">
                  Concurrency
                </Label>
                <select
                  id="wizard-run-mode"
                  value={runMode}
                  onChange={event =>
                    setRunMode(event.target.value as RunPolicy['mode'])
                  }
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="concurrent">Multiple workspaces</option>
                  <option value="exclusive">One Run per project</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wizard-port-allocation" className="text-xs">
                  Run ports
                </Label>
                <select
                  id="wizard-port-allocation"
                  value={portAllocation}
                  onChange={event =>
                    setPortAllocation(
                      event.target.value as RunPolicy['portAllocation']
                    )
                  }
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="none">Use declared ports as-is</option>
                  <option value="workspace">Allocate per workspace</option>
                </select>
              </div>
            </div>
            {portAllocation === 'workspace' && (
              <div className="space-y-1.5">
                <Label htmlFor="wizard-ports-per-workspace" className="text-xs">
                  Ports reserved per workspace
                </Label>
                <Input
                  id="wizard-ports-per-workspace"
                  type="number"
                  min={1}
                  max={50}
                  value={portsPerWorkspace}
                  onChange={event => setPortsPerWorkspace(event.target.value)}
                  className="max-w-28 font-mono text-base md:text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Declared app ports below map in order to JEAN_PORT_1,
                  JEAN_PORT_2, and label-based variables such as JEAN_PORT_WEB.
                </p>
              </div>
            )}
          </div>

          {/* Ports */}
          <div className="space-y-1.5">
            <Label className="text-sm">App Ports</Label>
            {ports.map((entry, i) => (
              <div key={entry.id} className="flex items-start gap-1">
                <div
                  data-testid="jean-config-wizard-port-fields"
                  className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:flex sm:gap-1"
                >
                  <Input
                    placeholder="Port"
                    type="number"
                    value={entry.port}
                    onChange={e => {
                      const next = [...ports]
                      next[i] = { ...entry, port: e.target.value }
                      setPorts(next)
                    }}
                    className="w-full font-mono text-base sm:w-24 md:text-sm"
                  />
                  <Input
                    placeholder="Host (optional)"
                    value={entry.host}
                    onChange={e => {
                      const next = [...ports]
                      next[i] = { ...entry, host: e.target.value }
                      setPorts(next)
                    }}
                    className="w-full font-mono text-base sm:w-40 md:text-sm"
                  />
                  <Input
                    placeholder="Label"
                    value={entry.label}
                    onChange={e => {
                      const next = [...ports]
                      next[i] = { ...entry, label: e.target.value }
                      setPorts(next)
                    }}
                    className="col-span-2 w-full text-base sm:w-auto sm:flex-1 md:text-sm"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0 sm:size-8"
                  onClick={() => setPorts(ports.filter(p => p.id !== entry.id))}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-11 text-xs sm:h-7"
              onClick={() =>
                setPorts([
                  ...ports,
                  {
                    id: crypto.randomUUID(),
                    port: '',
                    label: '',
                    host: '',
                  },
                ])
              }
            >
              <Plus className="mr-1 h-3 w-3" />
              Add port
            </Button>
            <p className="text-xs text-muted-foreground">
              These are the normal app ports and labels. Without allocation,
              CMD+O opens them as-is. With workspace allocation, Jean maps them
              in order onto the workspace range and CMD+O opens the mapped port.
              Host defaults to localhost.
            </p>
          </div>
        </div>

        <DialogFooter
          data-testid="jean-config-wizard-actions"
          className="shrink-0 flex-row justify-end border-t bg-background px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:px-6 sm:py-4"
        >
          <Button
            variant="ghost"
            className="h-11 min-w-20 sm:h-9"
            onClick={handleSkip}
          >
            Skip
          </Button>
          <Button
            className="h-11 min-w-20 sm:h-9"
            onClick={handleSave}
            disabled={!hasContent || saveConfig.isPending}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
