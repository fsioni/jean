import React, { useState, useCallback, useEffect } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  useJeanConfig,
  useSaveJeanConfig,
  normalizeRunScripts,
  type RunPolicy,
  type RunScripts,
  type NamedRunScript,
} from '@/services/projects'

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)

export function JeanJsonPane({
  projectPath,
}: {
  projectId: string
  projectPath: string
}) {
  const { data: jeanConfig } = useJeanConfig(projectPath)
  const saveJeanConfig = useSaveJeanConfig()

  const [localSetup, setLocalSetup] = useState('')
  const [localTeardown, setLocalTeardown] = useState('')
  const [localRun, setLocalRun] = useState<
    {
      id: string
      scriptId: string
      value: string
      label?: string | null
      isDefault: boolean
    }[]
  >(() => [
    {
      id: crypto.randomUUID(),
      scriptId: 'default',
      value: '',
      isDefault: true,
    },
  ])
  const [localPorts, setLocalPorts] = useState<
    { id: string; port: string; label: string; host: string }[]
  >([])
  const [runMode, setRunMode] = useState<RunPolicy['mode']>('concurrent')
  const [portAllocation, setPortAllocation] =
    useState<RunPolicy['portAllocation']>('none')
  const [portsPerWorkspace, setPortsPerWorkspace] = useState('10')
  const [synced, setSynced] = useState(false)

  // Sync from query data
  useEffect(() => {
    if (jeanConfig) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalSetup(jeanConfig.scripts.setup ?? '')
      setLocalTeardown(jeanConfig.scripts.teardown ?? '')
      setRunMode(jeanConfig.runPolicy?.mode ?? 'concurrent')
      setPortAllocation(jeanConfig.runPolicy?.portAllocation ?? 'none')
      setPortsPerWorkspace(
        String(jeanConfig.runPolicy?.portsPerWorkspace ?? 10)
      )
      const scriptEntries =
        typeof jeanConfig.scripts.run === 'object' &&
        jeanConfig.scripts.run !== null &&
        !Array.isArray(jeanConfig.scripts.run)
          ? Object.entries(jeanConfig.scripts.run).map(
              ([scriptId, script]) => ({
                scriptId,
                value: script.command,
                label: script.label,
                isDefault: script.default === true,
              })
            )
          : normalizeRunScripts(jeanConfig.scripts.run).map((value, index) => ({
              scriptId: index === 0 ? 'default' : `run-${index + 1}`,
              value,
              isDefault: index === 0,
            }))
      setLocalRun(
        (scriptEntries.length > 0
          ? scriptEntries
          : [
              {
                scriptId: 'default',
                value: '',
                isDefault: true,
              },
            ]
        ).map(entry => ({
          id: crypto.randomUUID(),
          ...entry,
        }))
      )

      const ports = jeanConfig.ports ?? []
      setLocalPorts(
        ports.map(p => ({
          id: crypto.randomUUID(),
          port: String(p.port),
          label: p.label,
          host: p.host ?? '',
        }))
      )

      setSynced(true)
    }
  }, [jeanConfig])

  const originalRunScripts = normalizeRunScripts(jeanConfig?.scripts.run)
  const currentRunFiltered: string[] = []
  for (const s of localRun) {
    if (s.value.trim()) currentRunFiltered.push(s.value)
  }
  const currentPortsFiltered: { port: string; label: string; host: string }[] =
    []
  for (const p of localPorts) {
    if (p.port.trim() && p.label.trim()) {
      currentPortsFiltered.push({
        port: p.port,
        label: p.label,
        host: p.host,
      })
    }
  }
  const originalPorts = (jeanConfig?.ports ?? []).map(p => ({
    port: String(p.port),
    label: p.label,
    host: p.host ?? '',
  }))
  const configuredRunPolicy = jeanConfig?.runPolicy
  const originalRunPolicy: RunPolicy | null =
    !configuredRunPolicy ||
    (configuredRunPolicy.mode === 'concurrent' &&
      configuredRunPolicy.portAllocation === 'none')
      ? null
      : {
          ...configuredRunPolicy,
          portsPerWorkspace: configuredRunPolicy.portsPerWorkspace ?? 10,
        }
  const currentRunPolicy: RunPolicy | null =
    runMode === 'concurrent' && portAllocation === 'none'
      ? null
      : {
          mode: runMode,
          portAllocation,
          portsPerWorkspace: Math.min(
            50,
            Math.max(1, Number(portsPerWorkspace) || 10)
          ),
        }

  const hasChanges = synced
    ? localSetup !== (jeanConfig?.scripts.setup ?? '') ||
      localTeardown !== (jeanConfig?.scripts.teardown ?? '') ||
      JSON.stringify(currentRunFiltered) !==
        JSON.stringify(originalRunScripts) ||
      JSON.stringify(currentPortsFiltered) !== JSON.stringify(originalPorts) ||
      JSON.stringify(currentRunPolicy) !== JSON.stringify(originalRunPolicy)
    : localSetup.trim() !== '' ||
      localTeardown.trim() !== '' ||
      currentRunFiltered.length > 0 ||
      currentPortsFiltered.length > 0

  const handleSave = useCallback(() => {
    const filtered: string[] = []
    for (const s of localRun) {
      if (s.value.trim()) filtered.push(s.value)
    }
    const runCommandsChanged =
      JSON.stringify(filtered) !== JSON.stringify(originalRunScripts)
    let run: RunScripts | null = jeanConfig?.scripts.run ?? null
    if (runCommandsChanged) {
      run = null
      const wasNamed =
        typeof jeanConfig?.scripts.run === 'object' &&
        jeanConfig.scripts.run !== null &&
        !Array.isArray(jeanConfig.scripts.run)
      if (wasNamed) {
        const namedRun = localRun.reduce<Record<string, NamedRunScript>>(
          (scripts, entry) => {
            if (!entry.value.trim()) return scripts
            scripts[entry.scriptId] = {
              command: entry.value.trim(),
              label: entry.label || undefined,
              default: entry.isDefault || undefined,
            }
            return scripts
          },
          {}
        )
        run = Object.keys(namedRun).length > 0 ? namedRun : null
      } else if (filtered.length === 1) run = filtered[0] ?? null
      else if (filtered.length > 1) run = filtered
    }

    const validPorts = localPorts.flatMap(p => {
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

    saveJeanConfig.mutate({
      projectPath,
      config: {
        scripts: {
          setup: localSetup.trim() || null,
          teardown: localTeardown.trim() || null,
          run,
        },
        ports: validPorts.length > 0 ? validPorts : null,
        runPolicy:
          runMode === 'concurrent' && portAllocation === 'none'
            ? null
            : {
                mode: runMode,
                portAllocation,
                portsPerWorkspace: Math.min(
                  50,
                  Math.max(
                    1,
                    validPorts.length,
                    Number(portsPerWorkspace) || 10
                  )
                ),
              },
      },
    })
  }, [
    localSetup,
    localTeardown,
    localRun,
    localPorts,
    jeanConfig?.scripts.run,
    originalRunScripts,
    runMode,
    portAllocation,
    portsPerWorkspace,
    projectPath,
    saveJeanConfig,
  ])

  return (
    <div className="space-y-6">
      <SettingsSection title="Automation Scripts">
        <p className="text-xs text-muted-foreground">
          Scripts from jean.json — setup runs after worktree creation, teardown
          before deletion, run launches via the run command
        </p>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="setup-script" className="text-sm">
              Setup
            </Label>
            <Input
              id="setup-script"
              placeholder="e.g. npm install"
              value={localSetup}
              onChange={e => setLocalSetup(e.target.value)}
              className="font-mono text-base md:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Runs automatically after a new worktree is created
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Run</Label>
            {localRun.map((entry, i) => (
              <div key={entry.id} className="flex items-center gap-1">
                <Input
                  placeholder="e.g. npm run dev"
                  value={entry.value}
                  onChange={e => {
                    const next = [...localRun]
                    next[i] = { ...entry, value: e.target.value }
                    setLocalRun(next)
                  }}
                  className="font-mono text-base md:text-sm"
                />
                {localRun.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() =>
                      setLocalRun(localRun.filter(s => s.id !== entry.id))
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
              className="h-7 text-xs"
              onClick={() =>
                setLocalRun([
                  ...localRun,
                  {
                    id: crypto.randomUUID(),
                    scriptId: `run-${crypto.randomUUID().slice(0, 8)}`,
                    value: '',
                    isDefault: localRun.length === 0,
                  },
                ])
              }
            >
              <Plus className="mr-1 h-3 w-3" />
              Add command
            </Button>
            <p className="text-xs text-muted-foreground">
              Launches via the run command in the toolbar
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">App Ports</Label>
            {localPorts.map((entry, i) => (
              <div key={entry.id} className="flex items-center gap-1">
                <Input
                  placeholder="Port"
                  type="number"
                  value={entry.port}
                  onChange={e => {
                    const next = [...localPorts]
                    next[i] = { ...entry, port: e.target.value }
                    setLocalPorts(next)
                  }}
                  className="font-mono text-base md:text-sm w-24"
                />
                <Input
                  placeholder="Host (optional)"
                  value={entry.host}
                  onChange={e => {
                    const next = [...localPorts]
                    next[i] = { ...entry, host: e.target.value }
                    setLocalPorts(next)
                  }}
                  className="font-mono text-base md:text-sm w-40"
                />
                <Input
                  placeholder="Label"
                  value={entry.label}
                  onChange={e => {
                    const next = [...localPorts]
                    next[i] = { ...entry, label: e.target.value }
                    setLocalPorts(next)
                  }}
                  className="text-base md:text-sm"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() =>
                    setLocalPorts(localPorts.filter(p => p.id !== entry.id))
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                setLocalPorts([
                  ...localPorts,
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
              Normal app ports and labels. With workspace allocation Jean maps
              them in order onto the allocated range; CMD+O opens the mapped
              port. Host defaults to localhost.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="teardown-script" className="text-sm">
              Teardown
            </Label>
            <Input
              id="teardown-script"
              placeholder="e.g. docker compose down"
              value={localTeardown}
              onChange={e => setLocalTeardown(e.target.value)}
              className="font-mono text-base md:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Runs automatically before a worktree is deleted/archived
            </p>
          </div>
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <p>
              <code className="text-foreground/80">$JEAN_WORKSPACE_PATH</code>
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
      </SettingsSection>
      <SettingsSection title="Run Management">
        <p className="text-xs text-muted-foreground">
          Choose whether workspaces can run together and whether Jean assigns a
          stable port range to each workspace.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="run-mode" className="text-sm">
              Concurrency
            </Label>
            <select
              id="run-mode"
              value={runMode}
              onChange={event =>
                setRunMode(event.target.value as RunPolicy['mode'])
              }
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="concurrent">Multiple workspaces</option>
              <option value="exclusive">One Run per project</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Exclusive mode gracefully stops the previous project Run first.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="port-allocation" className="text-sm">
              Ports
            </Label>
            <select
              id="port-allocation"
              value={portAllocation}
              onChange={event =>
                setPortAllocation(
                  event.target.value as RunPolicy['portAllocation']
                )
              }
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="none">Project defaults</option>
              <option value="workspace">Allocate per workspace</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Allocations stay stable across restarts and archives.
            </p>
          </div>
        </div>
        {portAllocation === 'workspace' && (
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="ports-per-workspace" className="text-sm">
              Ports per workspace
            </Label>
            <Input
              id="ports-per-workspace"
              type="number"
              min={1}
              max={50}
              value={portsPerWorkspace}
              onChange={event => setPortsPerWorkspace(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              App ports map in order to JEAN_PORT_1, JEAN_PORT_2, and
              label-based variables such as JEAN_PORT_WEB. The first is also
              JEAN_PORT; the range size is JEAN_PORT_COUNT.
            </p>
          </div>
        )}
      </SettingsSection>
      <Button
        size="sm"
        onClick={handleSave}
        disabled={!hasChanges || saveJeanConfig.isPending}
      >
        {saveJeanConfig.isPending && (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        Save jean.json
      </Button>
    </div>
  )
}
