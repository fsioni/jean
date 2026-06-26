import React from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  terminalFontOptions,
  type TerminalFont,
  type TerminalRenderer,
} from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'

const InlineField: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
    <div className="space-y-0.5 sm:w-56 sm:shrink-0 lg:w-72">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
    </div>
    {children}
  </div>
)

export const TerminalPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Terminal"
        anchorId="pref-terminal-section-terminal"
      >
        <InlineField
          label="Embedded terminal renderer"
          description="Ghostty Web is experimental. Changes apply to newly opened terminal tabs."
        >
          <Select
            value={preferences?.terminal_renderer ?? 'xterm'}
            onValueChange={value => {
              patchPreferences.mutate({
                terminal_renderer: value as TerminalRenderer,
              })
            }}
            disabled={patchPreferences.isPending}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="xterm">xterm.js (stable)</SelectItem>
              <SelectItem value="ghostty-web">
                Ghostty Web (experimental)
              </SelectItem>
            </SelectContent>
          </Select>
        </InlineField>

        <InlineField
          label="Terminal font"
          description="Applies to existing and newly opened terminal tabs."
        >
          <Select
            value={preferences?.terminal_font ?? 'jetbrains-mono'}
            onValueChange={value => {
              patchPreferences.mutate({
                terminal_font: value as TerminalFont,
              })
            }}
            disabled={patchPreferences.isPending}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {terminalFontOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InlineField>

        <InlineField
          label="Terminal font size"
          description="Applies to existing and newly opened terminal tabs."
        >
          <Select
            value={String(preferences?.terminal_font_size ?? 13)}
            onValueChange={value => {
              patchPreferences.mutate({
                terminal_font_size: Number(value),
              })
            }}
            disabled={patchPreferences.isPending}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map(size => (
                <SelectItem key={size} value={String(size)}>
                  {size}px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InlineField>
      </SettingsSection>
    </div>
  )
}
