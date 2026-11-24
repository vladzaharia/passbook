import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
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
  useFormErrors,
} from '@/web/ui/index.ts';
import { ROLE_LABELS, ROLES } from '../orgs/org-roles.ts';
import { KeyDisclosure } from './key-disclosure.tsx';
import { KindFields, SHORT_EXPIRY } from './key-kind-fields.tsx';
import { KeyReview } from './key-review.tsx';
import { type ApiKey, SCOPE_LABEL, useCreateKey } from './queries.ts';
import { type SCOPES, ScopeRows, TerminalRows } from './scope-rows.tsx';
import { useKeyScopes } from './use-key-scopes.ts';

const DAY = 86_400_000;
/** The least a key can do; more is ticked on purpose. */
const DEFAULT_SCOPES = ['passes:read'];
const EXPIRY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
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
  capabilities: readonly OrgCapability[] | null;
  developerOrg: boolean;
}

export function CreateKeyDialog({
  open,
  onOpenChange,
  principal,
  orgId,
  orgName,
  capabilities,
  developerOrg,
}: CreateKeyDialogProps) {
  const create = useCreateKey(principal);
  const [name, setName] = useState('');
  const picked = useKeyScopes(DEFAULT_SCOPES, orgId, capabilities, developerOrg);
  const { scopes } = picked;
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
    picked.reset();
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

  function changeKind(next: 'service' | 'personal') {
    setKind(next);
    picked.reconcile(next, keyMode);
  }

  function changeMode(next: Mode) {
    setKeyMode(next);
    picked.reconcile(kind, next);
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
          <KindFields
            orgId={orgId}
            kind={kind}
            onKind={changeKind}
            access={access}
            onAccess={setAccess}
            ips={ips}
            onIps={(next) => {
              setIps(next);
              setServer({});
            }}
            errors={errors}
          />
          {orgId === null ? (
            <FormField label="Mode" error={errors.mode}>
              {(p) => (
                <Select
                  {...p}
                  value={keyMode}
                  onValueChange={(next) => changeMode(next === 'test' ? 'test' : 'live')}
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
              onChange={picked.set}
              note={picked.note}
              error={errors.scopes}
              platform={orgId === null}
              kind={kind}
              mode={keyMode}
              capabilities={capabilities}
              developerOrg={developerOrg}
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
        title={
          orgId === null
            ? 'Create a platform key?'
            : kind === 'personal'
              ? 'Review personal key'
              : 'Review service key'
        }
        description={
          <KeyReview
            orgId={orgId}
            orgName={orgName}
            mode={keyMode}
            name={name.trim()}
            personal={kind === 'personal'}
            permissions={
              role ? ROLE_LABELS[role] : scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', ')
            }
            ipAllow={ipAllow}
            days={days}
          />
        }
        confirmLabel="Create key"
        onConfirm={submit}
      />
    </Dialog>
  );
}
