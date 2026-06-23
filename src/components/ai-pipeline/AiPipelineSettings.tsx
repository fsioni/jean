import React, { useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection } from '@/components/preferences/SettingsSection'
import {
  useAiPipelineConfig,
  useSaveAiPipelineConfig,
} from '@/services/ai-pipeline'

const Field: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="space-y-2">
    <div className="space-y-0.5">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
    </div>
    {children}
  </div>
)

/**
 * AI pipeline integration settings (dashboard URL + label), stored in the
 * isolated AI pipeline sidecar config (not in AppPreferences). The URL is never
 * hardcoded — the fork is public.
 */
export const AiPipelineSettings: React.FC = () => {
  const { data: config } = useAiPipelineConfig()
  const saveConfig = useSaveAiPipelineConfig()

  const [localUrl, setLocalUrl] = useState<string | null>(null)
  const [localLabel, setLocalLabel] = useState<string | null>(null)

  const currentUrl = config?.dashboardUrl ?? ''
  const currentLabel = config?.pipelineLabel ?? ''

  const url = localUrl ?? currentUrl
  const label = localLabel ?? currentLabel

  const changed =
    (localUrl !== null && localUrl !== currentUrl) ||
    (localLabel !== null && localLabel !== currentLabel)

  const handleSave = () => {
    saveConfig.mutate(
      {
        dashboardUrl: url.trim() || undefined,
        pipelineLabel: label.trim() || undefined,
      },
      {
        onSuccess: () => {
          setLocalUrl(null)
          setLocalLabel(null)
          toast.success('Configuration pipeline IA enregistrée')
        },
        onError: e => toast.error(`Échec de l'enregistrement : ${e}`),
      }
    )
  }

  return (
    <SettingsSection
      title="Pipeline IA"
      anchorId="pref-integrations-section-ai-pipeline"
    >
      <Field
        label="URL du dashboard"
        description="Base URL du dashboard de la pipeline IA (endpoint /prs). Stockée localement, jamais committée."
      >
        <Input
          placeholder="https://ai-agents.exemple.interne"
          value={url}
          onChange={e => setLocalUrl(e.target.value)}
          className="text-base md:text-sm font-mono"
        />
      </Field>

      <Field
        label="Label pipeline (optionnel)"
        description="Label porté par les PR de la pipeline (défaut : ai-full-flow). Les branches CU-<id> sont reconnues quel que soit le label."
      >
        <Input
          placeholder="ai-full-flow"
          value={label}
          onChange={e => setLocalLabel(e.target.value)}
          className="text-base md:text-sm font-mono"
        />
      </Field>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!changed || saveConfig.isPending}
        >
          {saveConfig.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </SettingsSection>
  )
}
