import type { Mode } from '@/shared/contracts/common.ts';
import type { WalletProvider } from '@/shared/contracts/wallet-providers.ts';
import { Card, CardBody, CardHeader, ErrorState, SkeletonRows } from '@/web/ui/index.ts';
import { PROVIDER_NAME, releaseLine, releaseSummary } from './copy.ts';
import { CredentialRow } from './credential-row.tsx';
import { EnrolmentTable } from './enrolment-table.tsx';
import { usePlatformCredentials } from './queries.ts';
import { SamsungCards } from './samsung-cards.tsx';

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'live', label: 'Live' },
  { mode: 'test', label: 'Test' },
];

function ReleaseNote({ line }: { line: string | null }) {
  return line ? <p className="text-sm text-fg-muted">{line}</p> : null;
}

/** A Google or Samsung tab: PassBook's own credentials per mode, then every organization's enrolment. */
export function ProviderTab({ provider }: { provider: WalletProvider }) {
  const credentials = usePlatformCredentials();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title={`${PROVIDER_NAME[provider]} credentials`} />
        <CardBody className="flex flex-col gap-3">
          {credentials.isPending ? (
            <SkeletonRows rows={2} label="Loading credentials" />
          ) : credentials.isError ? (
            <ErrorState
              subject="credentials"
              error={credentials.error}
              onRetry={() => credentials.refetch()}
            />
          ) : (
            <>
              <ReleaseNote line={releaseSummary(provider, credentials.data.release[provider])} />
              {MODES.map(({ mode, label }) => {
                const credential = credentials.data.items.find(
                  (c) =>
                    c.provider === provider &&
                    c.mode === mode &&
                    c.scope === 'platform' &&
                    c.revokedAt === null,
                );
                return (
                  <div key={mode} className="flex flex-col gap-2">
                    <CredentialRow
                      label={label}
                      target={{ kind: 'platform', mode }}
                      provider={provider}
                      canManage
                      credential={credential}
                    />
                    {provider === 'samsung' && credential ? (
                      <SamsungCards
                        credential={credential}
                        notice={releaseLine(provider, credentials.data.release[provider][mode])}
                      />
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
        </CardBody>
      </Card>
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-fg-strong">Organizations</h2>
        {credentials.data ? (
          <ReleaseNote line={releaseSummary(provider, credentials.data.release[provider])} />
        ) : null}
        <EnrolmentTable provider={provider} />
      </section>
    </div>
  );
}
