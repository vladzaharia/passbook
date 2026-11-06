import { useId } from 'react';
import type { Mode } from '../../../shared/contracts/common.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { Checkbox } from '../../ui/checkbox.tsx';
import { Dialog, DialogContent } from '../../ui/dialog.tsx';
import { FormField } from '../../ui/field.tsx';
import { Label } from '../../ui/label.tsx';
import { ModePill } from '../../ui/layout/mode-pill.tsx';
import { Select } from '../../ui/select.tsx';
import { UI_COPY } from '../ui/copy.ts';

function TemplateRow({
  choice,
  checked,
  onChange,
}: {
  choice: ScopeChoice;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-9 items-center gap-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="text-sm">
        {choice.label}
      </Label>
    </div>
  );
}

export interface ScopeChoice {
  value: string;
  label: string;
}

/**
 * Scan as admin: pick the organization, then an event or the templates to accept. The mode comes
 * from the console switch; the pill and the switch link show it here.
 */
export function AdminScopeSheet({
  open,
  onOpenChange,
  orgs,
  org,
  onOrg,
  kind,
  choices,
  event,
  onEvent,
  templateIds,
  onTemplates,
  mode,
  onSwitchMode,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgs: readonly ScopeChoice[];
  org: string;
  onOrg: (id: string) => void;
  kind: 'event' | 'templates';
  choices: readonly ScopeChoice[];
  event?: string;
  onEvent?: (id: string) => void;
  templateIds?: readonly string[];
  onTemplates?: (ids: string[]) => void;
  mode: Mode;
  onSwitchMode: () => void;
  onContinue: () => void;
}) {
  const ready = kind === 'event' ? Boolean(event) : (templateIds?.length ?? 0) > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={UI_COPY.scanAsAdmin}
        size="sm"
        footer={
          <Button disabled={!ready} onClick={onContinue} data-testid="admin-scope-continue">
            {UI_COPY.continue}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <ModePill mode={mode} />
            <Button variant="link" onClick={onSwitchMode}>
              {mode === 'test' ? UI_COPY.switchToLive : UI_COPY.switchToTest}
            </Button>
          </div>
          <FormField label={UI_COPY.organization}>
            {(props) => (
              <Select
                {...props}
                options={orgs}
                value={org}
                onValueChange={onOrg}
                className="w-full"
              />
            )}
          </FormField>
          {kind === 'event' ? (
            <FormField label={UI_COPY.event}>
              {(props) => (
                <Select
                  {...props}
                  options={choices}
                  value={event}
                  onValueChange={(v) => onEvent?.(v)}
                  className="w-full"
                />
              )}
            </FormField>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-fg-strong">
                {UI_COPY.templates}
              </legend>
              {choices.map((c) => (
                <TemplateRow
                  key={c.value}
                  choice={c}
                  checked={templateIds?.includes(c.value) ?? false}
                  onChange={(on) => {
                    const cur = templateIds ?? [];
                    onTemplates?.(on ? [...cur, c.value] : cur.filter((x) => x !== c.value));
                  }}
                />
              ))}
            </fieldset>
          )}
          <p className="sr-only">{SCAN_COPY.actions.startScanning}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
