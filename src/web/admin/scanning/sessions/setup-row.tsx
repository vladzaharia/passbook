import type { ReactNode } from 'react';
import { Button, Callout } from '@/web/ui/index.ts';

/** One question of the session's setup: its label, its answer, and the actions beside it. */
export function SetupRow({
  label,
  actions,
  children,
}: {
  label: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="grid gap-x-6 gap-y-2 border-t border-border px-4 py-4 first:border-t-0 sm:grid-cols-[7rem_minmax(0,1fr)_auto]"
    >
      <h3 className="text-sm text-fg-muted sm:pt-1">{label}</h3>
      <div className="min-w-0">{children}</div>
      {actions ? (
        <div className="flex flex-wrap items-start gap-1 sm:justify-end">{actions}</div>
      ) : null}
    </section>
  );
}

/** The fields of a row being edited, with Save and Cancel under them. */
export function RowEditor({
  children,
  onSave,
  onCancel,
  saving,
  disabled,
  error,
}: {
  children: ReactNode;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  disabled?: boolean;
  error?: string | undefined;
}) {
  return (
    <div className="grid gap-4 rounded-lg border border-border-strong bg-surface-raised p-4">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {children}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" loading={saving} disabled={disabled} onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  );
}
