import { useState } from 'react';
import { VISITOR_COPY } from '@/shared/copy/visitors.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  Select,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import { useHosts, useNewVisitor } from './api.ts';

const OTHER = '__other';
const pad = (n: number) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const at = (date: string, clock: string) => new Date(`${date}T${clock}`).getTime();

export function NewVisitorDialog({
  open,
  onOpenChange,
  orgId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
}) {
  const create = useNewVisitor(orgId);
  const hosts = useHosts(orgId).data?.items ?? [];
  // A member is chosen by id (emails are for members:manage); OTHER (or no members) shows the typed name and email.
  const [pick, setPick] = useState('');
  const canType = hosts.length === 0 || hosts.some((h) => h.email !== null);
  const typed = canType && (pick === OTHER || hosts.length === 0);
  const [f, setF] = useState({
    name: '',
    email: '',
    hostName: '',
    hostEmail: '',
    date: today(),
    from: '09:00',
    until: '17:00',
    note: '',
  });
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }));
  const from = at(f.date, f.from);
  const until = at(f.date, f.until);
  const check = useFormErrors({
    ...(f.name.trim() ? {} : { name: 'Required.' }),
    ...(typed
      ? {
          ...(f.hostName.trim() ? {} : { hostName: 'Required.' }),
          ...(f.hostEmail.trim() ? {} : { hostEmail: 'Required.' }),
        }
      : pick
        ? {}
        : { hostUserId: 'Choose a host.' }),
    ...(Number.isFinite(from) && Number.isFinite(until) && until > from
      ? {}
      : { until: 'Choose a later time.' }),
  });
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };

  function close() {
    onOpenChange(false);
    setServer({});
    setFormError(undefined);
    check.reset();
  }

  async function submit() {
    setFormError(undefined);
    setServer({});
    try {
      const made = await create.mutateAsync({
        name: f.name.trim(),
        ...(f.email.trim() ? { email: f.email.trim() } : {}),
        ...(typed
          ? { hostName: f.hostName.trim(), hostEmail: f.hostEmail.trim() }
          : { hostUserId: pick }),
        windowFrom: from,
        windowUntil: until,
        ...(f.note.trim() ? { note: f.note.trim() } : {}),
      });
      (f.email.trim() ? toast.sent : toast.success)(
        f.email.trim() ? `Invite sent to ${made.name}` : VISITOR_COPY.toast.invited,
      );
      setF((prev) => ({ ...prev, name: '', email: '', note: '' }));
      close();
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      else setFormError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      dirty={f.name.trim() !== '' || f.hostName.trim() !== ''}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="md"
        title={VISITOR_COPY.new}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="new-visitor" loading={create.isPending}>
              {VISITOR_COPY.invite}
            </Button>
          </>
        }
      >
        <Form id="new-visitor" className="flex flex-col gap-4" {...check.form} onValid={submit}>
          <FormField label={VISITOR_COPY.form.name} required error={errors.name}>
            {(p) => (
              <Input
                {...p}
                data-autofocus
                autoComplete="off"
                value={f.name}
                maxLength={80}
                onChange={(e) => set({ name: e.target.value })}
              />
            )}
          </FormField>
          <FormField
            label={VISITOR_COPY.form.email}
            help={VISITOR_COPY.form.emailHelp}
            error={errors.email}
          >
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="off"
                value={f.email}
                onChange={(e) => set({ email: e.target.value })}
              />
            )}
          </FormField>
          {hosts.length > 0 ? (
            <FormField
              label={VISITOR_COPY.form.host}
              help={typed ? undefined : VISITOR_COPY.form.hostHelp}
              required
              error={typed ? undefined : errors.hostUserId}
            >
              {(p) => (
                <Select
                  {...p}
                  value={pick || undefined}
                  placeholder={VISITOR_COPY.form.hostPick}
                  options={[
                    ...hosts.map((h) => ({
                      value: h.id,
                      label: h.email ? `${h.name} · ${h.email}` : h.name,
                    })),
                    ...(canType ? [{ value: OTHER, label: VISITOR_COPY.form.hostOther }] : []),
                  ]}
                  onValueChange={setPick}
                />
              )}
            </FormField>
          ) : null}
          {typed ? (
            <>
              <FormField label={VISITOR_COPY.form.hostName} required error={errors.hostName}>
                {(p) => (
                  <Input
                    {...p}
                    autoComplete="off"
                    value={f.hostName}
                    maxLength={80}
                    onChange={(e) => set({ hostName: e.target.value })}
                  />
                )}
              </FormField>
              <FormField
                label={VISITOR_COPY.form.hostEmail}
                help={VISITOR_COPY.form.hostHelp}
                required
                error={errors.hostEmail}
              >
                {(p) => (
                  <Input
                    {...p}
                    type="email"
                    autoComplete="off"
                    value={f.hostEmail}
                    onChange={(e) => set({ hostEmail: e.target.value })}
                  />
                )}
              </FormField>
            </>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label={VISITOR_COPY.form.date} required>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={f.date}
                  onChange={(e) => set({ date: e.target.value })}
                />
              )}
            </FormField>
            <FormField label={VISITOR_COPY.form.from} required>
              {(p) => (
                <Input
                  {...p}
                  type="time"
                  value={f.from}
                  onChange={(e) => set({ from: e.target.value })}
                />
              )}
            </FormField>
            <FormField
              label={VISITOR_COPY.form.until}
              required
              error={errors.windowUntil ?? errors.until}
            >
              {(p) => (
                <Input
                  {...p}
                  type="time"
                  value={f.until}
                  onChange={(e) => set({ until: e.target.value })}
                />
              )}
            </FormField>
          </div>
          <FormField label={VISITOR_COPY.form.note} error={errors.note}>
            {(p) => (
              <Input
                {...p}
                value={f.note}
                maxLength={100}
                onChange={(e) => set({ note: e.target.value })}
              />
            )}
          </FormField>
          {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
