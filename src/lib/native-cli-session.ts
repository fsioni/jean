import type { Session } from '@/types/chat'

export type NativeTerminalBackend = 'claude' | 'codex' | 'opencode'

export interface NativeTerminalLaunch {
  command: string
  args: string[]
}

export function isNativeTerminalBackend(
  backend: Session['backend']
): backend is NativeTerminalBackend {
  return backend === 'claude' || backend === 'codex' || backend === 'opencode'
}

export function getNativeSessionId(session: Session): string | null {
  if (session.backend === 'claude') {
    return session.claude_session_id ?? null
  }
  if (session.backend === 'codex') {
    return session.codex_thread_id ?? null
  }
  if (session.backend === 'opencode') {
    return session.opencode_session_id ?? null
  }
  return null
}

function stripClaudeSessionArgs(args: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--resume' || arg === '-r' || arg === '--session-id') {
      index += 1
      continue
    }
    if (arg?.startsWith('--resume=') || arg?.startsWith('--session-id=')) {
      continue
    }
    if (arg) result.push(arg)
  }
  return result
}

function stripCodexSessionArgs(args: string[]): string[] {
  const resumeIndex = args.indexOf('resume')
  return resumeIndex >= 0 ? args.slice(0, resumeIndex) : [...args]
}

function stripOpenCodeSessionArgs(args: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--session' || arg === '-s') {
      index += 1
      continue
    }
    if (arg === '--continue' || arg === '-c' || arg?.startsWith('--session=')) {
      continue
    }
    if (arg) result.push(arg)
  }
  return result
}

export function buildNativeResumeArgs(
  backend: NativeTerminalBackend,
  nativeSessionId: string,
  persistedArgs: string[] = []
): string[] {
  if (backend === 'claude') {
    return [
      ...stripClaudeSessionArgs(persistedArgs),
      '--resume',
      nativeSessionId,
    ]
  }
  if (backend === 'codex') {
    return [...stripCodexSessionArgs(persistedArgs), 'resume', nativeSessionId]
  }
  return [
    ...stripOpenCodeSessionArgs(persistedArgs),
    '--session',
    nativeSessionId,
  ]
}

export function hasLegacyNativeResumeArgs(session: Session): boolean {
  const args = session.terminal_command_args ?? []
  if (session.backend === 'claude') {
    return args.some(
      arg => arg === '--resume' || arg === '-r' || arg.startsWith('--resume=')
    )
  }
  if (session.backend === 'codex') {
    return args.includes('resume')
  }
  if (session.backend === 'opencode') {
    return args.some(
      arg => arg === '--session' || arg === '-s' || arg.startsWith('--session=')
    )
  }
  return false
}

export function getNativeTerminalResumeLaunch(
  session: Session
): NativeTerminalLaunch | null {
  if (!isNativeTerminalBackend(session.backend)) {
    return null
  }

  const command = session.terminal_command
  if (!command) return null

  const nativeSessionId = getNativeSessionId(session)
  if (nativeSessionId) {
    return {
      command,
      args: buildNativeResumeArgs(
        session.backend,
        nativeSessionId,
        session.terminal_command_args ?? []
      ),
    }
  }

  if (hasLegacyNativeResumeArgs(session)) {
    return {
      command,
      args: session.terminal_command_args ?? [],
    }
  }

  return null
}
