# Managed Runs

Jean can own a project's development processes instead of treating them as
ordinary terminal commands. Managed Runs provide lifecycle state, graceful
shutdown, optional project exclusivity, and stable per-workspace port ranges.

## `jean.json` configuration

The feature is opt-in. A project without `runPolicy` keeps the historical
behavior: Runs may execute concurrently and Jean does not allocate ports.

```json
{
  "scripts": {
    "run": "bun run dev",
    "teardown": "docker compose down"
  },
  "runPolicy": {
    "mode": "concurrent",
    "portAllocation": "workspace",
    "portsPerWorkspace": 10
  }
}
```

`mode` and `portAllocation` are independent:

| Setting             | Values                    | Effect                                                                                           |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `mode`              | `concurrent`, `exclusive` | `exclusive` stops the other active Run(s) in the same project before starting the requested Run. |
| `portAllocation`    | `none`, `workspace`       | `workspace` assigns each workspace a stable, non-overlapping port range.                         |
| `portsPerWorkspace` | 1–50                      | Size of the allocated range; defaults to 10.                                                     |

This allows both common workflows: one shared Run on project-default ports, or
multiple isolated workspaces running simultaneously on different ports.

Run scripts remain backward compatible with a string or string array. Named
scripts add stable IDs, labels, and an explicit default:

```json
{
  "scripts": {
    "run": {
      "web": {
        "command": "bun run dev --port $JEAN_PORT",
        "label": "Web",
        "default": true
      },
      "worker": {
        "command": "bun run worker",
        "label": "Worker"
      }
    }
  }
}
```

## Environment contract

Jean injects these variables into a managed Run:

- `JEAN_PROJECT_ID`, `JEAN_PROJECT_NAME`
- `JEAN_WORKSPACE_ID`, `JEAN_WORKSPACE_NAME`, `JEAN_WORKSPACE_PATH`
- `JEAN_ROOT_PATH`
- `JEAN_RUN_ID`
- `JEAN_PORT`, `JEAN_PORT_COUNT` when workspace allocation is enabled
- `JEAN_PORT_1`, `JEAN_PORT_2`, … for app ports declared in `ports`
- `JEAN_PORT_<LABEL>` for each declared port label, normalized to uppercase
  ASCII with underscores (for example `Web App` becomes `JEAN_PORT_WEB_APP`)

The same project/workspace variables and allocated port range are supplied to
the `teardown` hook. Repositories remain responsible for consuming the port
variables and for propagating `SIGTERM` through their own process launchers.

## Lifecycle

The Rust backend owns the PTY and persists Run metadata in the application data
directory. State changes are emitted as `run:updated` and can be recovered with
`get_project_runs`. States are `starting`, `running`, `stopping`, `stopped`,
`failed`, and `orphaned`.

Stopping sends `SIGTERM` to the process group and descendants, waits up to five
seconds, then force-kills anything still alive. Archiving or deleting a
workspace first stops its managed Runs and then executes `teardown`. Archives
retain the workspace's port range; permanent deletion releases it.

At startup Jean reconciles persisted active Runs. It only kills a surviving
process when the PID, creation time, and command/executable fingerprint all
match. An unverifiable process is left untouched and marked `orphaned` to avoid
killing an unrelated process after PID reuse.

## Port allocation

Allocations live in `run-ports.json` under Jean's application data directory.
Jean searches the TCP range 55000–64999, checks the complete requested block,
and avoids every persisted allocation. The project canvas displays the base
port and offers reallocation while the workspace Run is stopped.

The existing top-level `ports` list is the app-port declaration and remains the
source for labels, host names, CMD+O, and the embedded browser. Without
workspace allocation those ports are used unchanged. With workspace allocation
Jean maps them by declaration order onto the allocated range: the first entry
uses `JEAN_PORT`, the second uses `JEAN_PORT + 1`, and so on. The allocated
range automatically grows to fit the declared ports, up to the supported limit
of 50. Browser actions receive the resolved workspace-specific ports rather
than the static defaults.

Port reservation is cooperative rather than an operating-system lock: Jean
checks availability when allocating, but the repository's server must still
bind the assigned port and report bind failures normally.

## Transport rule

Managed Run commands are registered in the shared core dispatch so native
Tauri IPC and authenticated WebSocket clients use the same behavior. The
frontend prepares terminal output listeners, but only the Rust supervisor may
spawn or stop the managed process.
