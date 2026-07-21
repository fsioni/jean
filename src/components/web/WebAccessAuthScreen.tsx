import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface WebAccessAuthScreenProps {
  authError: string
  onTokenSubmit: (token: string) => void
}

export function WebAccessAuthScreen({
  authError,
  onTokenSubmit,
}: WebAccessAuthScreenProps) {
  const [token, setToken] = useState('')
  const [emptyError, setEmptyError] = useState(false)

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) {
      setEmptyError(true)
      return
    }
    setEmptyError(false)
    onTokenSubmit(trimmed)
  }

  return (
    <div className="mx-4 max-w-md rounded-lg border border-destructive/50 bg-background p-6 shadow-lg">
      <div className="flex items-center gap-2 text-destructive">
        <svg className="size-5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        <h2 className="text-sm font-semibold">Connection Failed</h2>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{authError}</p>

      <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
        <div className="space-y-1.5">
          <Label htmlFor="web-access-token">Access token</Label>
          <Input
            id="web-access-token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={event => {
              setToken(event.target.value)
              if (emptyError) setEmptyError(false)
            }}
            placeholder="Paste your Jean web access token"
          />
          {emptyError && (
            <p className="text-xs text-destructive">
              Enter the access token from Jean&apos;s Web Access settings.
            </p>
          )}
        </div>
        <Button type="submit" className="w-full">
          Connect
        </Button>
      </form>
    </div>
  )
}
