import React from 'react'
import { Separator } from '@/components/ui/separator'

export interface SettingsSectionProps {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  anchorId?: string
  children: React.ReactNode
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  actions,
  anchorId,
  children,
}) => (
  <div id={anchorId} className="space-y-4">
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-medium text-foreground">{title}</h3>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)
