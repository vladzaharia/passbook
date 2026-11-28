import { Cloud, Share2 } from 'lucide-react';
import { useState } from 'react';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { useMode } from '@/web/lib/mode.ts';
import { Button, CopyButton, FormGrid, Input, OptionTile, toast } from '@/web/ui/index.ts';
import { useGoogleAccountActions, useGoogleSharedInfo, useManagedGoogle } from './api.ts';
import { RunSteps } from './run-steps.tsx';

const COPY = PASS_SETUP_COPY.account;
const ACTIVE = new Set(['queued', 'running', 'waiting']);

/**
 * Google, before it has an account: two ways to get one. PassBook makes and runs an issuer, or the
 * org shares its own with PassBook's service account (no key changes hands). Choosing one is an
 * action, not a draft: it starts at once, like Get your own ID.
 */
export function AccountTiles({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const mode = useMode();
  const [choice, setChoice] = useState<'managed' | 'shared'>('managed');
  const [issuer, setIssuer] = useState('');
  const status = useManagedGoogle(orgId, canManage);
  const info = useGoogleSharedInfo(orgId, canManage && choice === 'shared');
  const { managed, share } = useGoogleAccountActions(orgId);
  const run = status.data?.run;
  const working = run ? ACTIVE.has(run.state) : false;
  const invalid = issuer !== '' && !/^[0-9]{1,32}$/.test(issuer);

  if (working || run?.state === 'failed')
    return (
      <div className="flex flex-col gap-3">
        <RunSteps
          labels={COPY.steps}
          at={run?.state === 'succeeded' ? COPY.steps.length : 0}
          failed={run?.state === 'failed'}
        />
        <p className="text-sm text-fg-muted">
          {run?.state === 'failed'
            ? COPY.failed
            : run?.state === 'waiting'
              ? COPY.waiting
              : COPY.steps[0]}
        </p>
        {run?.state === 'failed' && canManage ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              loading={managed.isPending}
              onClick={() => managed.mutate()}
            >
              {COPY.retry}
            </Button>
          </div>
        ) : null}
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <div
        role="radiogroup"
        aria-label={PASS_SETUP_COPY.channelsCard.account}
        className="grid gap-3 sm:grid-cols-2"
      >
        <OptionTile
          name={`google-account-${orgId}`}
          value="managed"
          label={COPY.managed}
          icon={Cloud}
          checked={choice === 'managed'}
          onSelect={() => setChoice('managed')}
          disabled={!canManage}
        />
        <OptionTile
          name={`google-account-${orgId}`}
          value="shared"
          label={COPY.shared}
          icon={Share2}
          checked={choice === 'shared'}
          onSelect={() => setChoice('shared')}
          disabled={!canManage}
        />
      </div>
      {choice === 'managed' ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!canManage || mode !== 'live'}
            loading={managed.isPending}
            onClick={() =>
              managed.mutate(undefined, { onError: (e) => toast.error(e, 'Could not start') })
            }
          >
            {COPY.create}
          </Button>
          {mode === 'live' ? null : <span className="text-xs text-fg-muted">{COPY.liveOnly}</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-muted">{COPY.addAs}</p>
          {info.data?.serviceAccountEmail ? (
            <p className="flex flex-wrap items-center gap-2 font-mono text-sm break-all">
              {info.data.serviceAccountEmail}
              <CopyButton value={info.data.serviceAccountEmail} label="address" />
            </p>
          ) : null}
          <FormGrid>
            <Input
              aria-label={COPY.issuerId}
              aria-invalid={invalid || undefined}
              inputMode="numeric"
              placeholder={COPY.issuerId}
              value={issuer}
              disabled={!canManage}
              onChange={(e) => setIssuer(e.target.value.trim())}
            />
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={!canManage || issuer === '' || invalid}
                loading={share.isPending}
                onClick={() =>
                  share.mutate(issuer, {
                    onSuccess: () => toast.success(COPY.connected),
                    onError: (e) => toast.error(e, 'Could not connect'),
                  })
                }
              >
                {COPY.connect}
              </Button>
            </div>
          </FormGrid>
          {invalid ? <p className="text-xs text-danger">{COPY.issuerError}</p> : null}
        </div>
      )}
    </div>
  );
}
