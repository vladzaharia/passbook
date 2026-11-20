import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { getMode } from '@/web/lib/mode.ts';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  Select,
  Textarea,
  useFormErrors,
} from '@/web/ui/index.ts';
import { ROLE_LABELS, ROLES } from '../orgs/org-roles.ts';
import { KeyDisclosure } from './key-disclosure.tsx';
import { type ApiKey, useCreateKey } from './queries.ts';
import { type SCOPES, ScopeRows, TerminalRows } from './scope-rows.tsx';

const DAY = 86_400_000;
/** The least a key can do; more is ticked on purpose. */
const DEFAULT_SCOPES = ['passes:read'];
const EXPIRY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];
/** A personal or platform key lives at most 90 days. */
const SHORT_EXPIRY = EXPIRY.slice(0, 2);
const KINDS = [
  { value: 'service', label: 'Service: for an integration' },
  { value: 'personal', label: 'Personal: acts as you' },
];
const ACCESS = [
  { value: 'scopes', label: 'Pick scopes' },
  ...ROLES.map((role) => ({ value: role, label: `Role: ${ROLE_LABELS[role]}` })),
];

const MODES = [
  { value: 'live', label: 'Live' },
  { value: 'test', label: 'Test' },
];

export interface CreateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  principal: string;
  orgId: string | null;
  orgName: string;
}

export function CreateKeyDialog({
  open,
  onOpenChange,
  principal,
  orgId,
  orgName,
}: CreateKeyDialogProps) {
  const create = useCreateKey(principal);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  const scansWrite = scopes.includes('scans:write');
  const [expiry, setExpiry] = useState('90');
  const [kind, setKind] = useState<'service' | 'personal'>('service');
  const [access, setAccess] = useState('scopes');
  const [ips, setIps] = useState('');
  const role = ROLES.find((r) => r === access);
  const ipAllow = ips.split(/[\s,]+/).filter(Boolean);
  const short = orgId === null || kind === 'personal';
  // A short-lived kind falls back to 90 days when the longer choice was picked first.
  const days = short && expiry !== '30' ? '90' : expiry;
  // An organization key takes the console's mode, shown without a choice. Platform pages ignore
  // mode, so a platform key's mode is chosen here.
  const [keyMode, setKeyMode] = useState<Mode>(getMode);
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [created, setCreated] = useState<ApiKey & { secret: string }>();
  const [reviewKey, setReviewKey] = useState(false);
  useEffect(() => {
    if (!open) return;
    setKeyMode(getMode());
  }, [open]);
  const check = useFormErrors({
    ...(name.trim() ? {} : { name: 'Required.' }),
    ...(role || scopes.length ? {} : { scopes: 'Pick at least one scope.' }),
    ...(orgId !== null || ipAllow.length ? {} : { ipAllow: 'Required for a platform key.' }),
    ...(!scansWrite || terminalIds.length ? {} : { terminalIds: 'Pick at least one terminal.' }),
  });
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };

  function close() {
    onOpenChange(false);
    setName('');
    setScopes(DEFAULT_SCOPES);
    setTerminalIds([]);
    setExpiry('90');
    setKind('service');
    setAccess('scopes');
    setIps('');
    setKeyMode(getMode());
    setServer({});
    check.reset();
    setFormError(undefined);
    setCreated(undefined);
    setReviewKey(false);
  }

  async function submit() {
    setFormError(undefined);
    try {
      const result = await create.mutateAsync({
        name: name.trim(),
        orgId,
        scopes: role ? [] : (scopes as (typeof SCOPES)[number][]),
        ...(role ? { roles: [role] } : {}),
        ...(orgId !== null ? { kind } : {}),
        ...(ipAllow.length ? { ipAllow } : {}),
        ...(scansWrite && !role ? { terminalIds } : {}),
        mode: keyMode,
        expiresAt: days === 'never' ? null : Date.now() + Number(days) * DAY,
      });
      setCreated(result);
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      else setFormError(errorMessage(cause));
    }
  }

  if (created) {
    return (
      <Dialog open={open} onOpenChange={() => undefined}>
        <DialogContent
          size="md"
          closeButton={false}
          title={
            <span className="inline-flex items-center gap-2">
              <span data-verb-done="" className="inline-flex text-accent-fg [&>svg]:size-4">
                <KeyRound aria-hidden />
              </span>
              Copy your key
            </span>
          }
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <KeyDisclosure
            created={created}
            organization={
              created.orgId === null
                ? 'Platform'
                : created.orgId === orgId
                  ? orgName
                  : created.orgId
            }
            onDone={close}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      dirty={
        name.trim() !== '' ||
        scopes.join() !== DEFAULT_SCOPES.join() ||
        expiry !== '90' ||
        kind !== 'service' ||
        access !== 'scopes' ||
        ips !== ''
      }
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="md"
        title="New API key"
        description="Choose the permissions and expiry for this credential."
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="new-key" loading={create.isPending}>
              Create
            </Button>
          </>
        }
      >
        <Form
          id="new-key"
          className="flex flex-col gap-4"
          {...check.form}
          onValid={() => setReviewKey(true)}
        >
          <FormField label="Name" required error={errors.name}>
            {(p) => (
              <Input
                {...p}
                data-autofocus
                autoComplete="off"
                placeholder="Box office sync"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setServer({});
                }}
              />
            )}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm font-medium text-fg">Organization</p>
              <p className="mt-2 text-sm text-fg-strong">{orgName}</p>
              {errors.orgId ? <p className="mt-1 text-xs text-danger">{errors.orgId}</p> : null}
            </div>
            <FormField label="Expires" error={errors.expiresAt}>
              {(p) => (
                <Select
                  {...p}
                  value={days}
                  onValueChange={setExpiry}
                  options={short ? SHORT_EXPIRY : EXPIRY}
                />
              )}
            </FormField>
          </div>
          {orgId === null ? null : (
            <FormField label="Type" error={errors.kind}>
              {(p) => (
                <Select
                  {...p}
                  value={kind}
                  onValueChange={(next) => setKind(next === 'personal' ? 'personal' : 'service')}
                  options={KINDS}
                />
              )}
            </FormField>
          )}
          {orgId === null ? null : (
            <FormField label="Access" error={errors.roles}>
              {(p) => <Select {...p} value={access} onValueChange={setAccess} options={ACCESS} />}
            </FormField>
          )}
          <FormField
            label={orgId === null ? 'Allowed IPs' : 'Allowed IPs (optional)'}
            required={orgId === null}
            error={errors.ipAllow}
          >
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                autoComplete="off"
                placeholder="203.0.113.0/24"
                value={ips}
                onChange={(e) => {
                  setIps(e.target.value);
                  setServer({});
                }}
              />
            )}
          </FormField>
          {orgId === null ? (
            <FormField label="Mode" error={errors.mode}>
              {(p) => (
                <Select
                  {...p}
                  value={keyMode}
                  onValueChange={(next) => setKeyMode(next === 'test' ? 'test' : 'live')}
                  options={MODES}
                />
              )}
            </FormField>
          ) : (
            <div>
              <p className="text-sm font-medium text-fg">Mode</p>
              <p className="mt-2 text-sm text-fg-strong">{keyMode === 'test' ? 'Test' : 'Live'}</p>
              <p className="mt-1 text-xs text-fg-muted">
                {keyMode === 'test'
                  ? 'Test passes. Their emails stay in the Test inbox. Switch the console to Live for a Live key.'
                  : 'Real passes and real emails. Switch the console to Test for a Test key.'}
              </p>
            </div>
          )}
          {role ? null : (
            <ScopeRows
              value={scopes}
              onChange={setScopes}
              error={errors.scopes}
              platform={orgId === null}
            />
          )}
          {scansWrite && orgId !== null && !role ? (
            <TerminalRows
              orgId={orgId}
              value={terminalIds}
              onChange={setTerminalIds}
              error={errors.terminalIds}
            />
          ) : null}
          {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </Form>
      </DialogContent>
      <ConfirmDialog
        open={reviewKey}
        onOpenChange={setReviewKey}
        title={orgId === null ? 'Create a platform key?' : 'Review service key'}
        description={
          <span className="block">
            <span className="block">
              {orgId === null ? (
                <>
                  This key can access all organizations in {keyMode === 'test' ? 'Test' : 'Live'}{' '}
                  mode.
                </>
              ) : (
                <>
                  This key is bound to {orgName} in {keyMode === 'test' ? 'Test' : 'Live'} mode.
                </>
              )}
            </span>
            <span className="mt-3 block">Name: {name.trim()}</span>
            <span className="block">
              {kind === 'personal' && orgId !== null ? 'Type: personal, acts as you.' : null}
            </span>
            <span className="block">
              Permissions: {role ? ROLE_LABELS[role] : scopes.join(', ')}
            </span>
            {ipAllow.length ? (
              <span className="block">Allowed IPs: {ipAllow.join(', ')}</span>
            ) : null}
            <span className="block">
              {days === 'never'
                ? 'It will not expire.'
                : `It expires after ${days === '365' ? '1 year' : `${days} days`}.`}
            </span>
            <span className="mt-3 block">
              No secret has been issued yet. It will be shown once after creation.
            </span>
          </span>
        }
        confirmLabel="Create key"
        onConfirm={submit}
      />
    </Dialog>
  );
}
