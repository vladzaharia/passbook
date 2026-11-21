import { Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { stoppingLevel } from '@/shared/channels.ts';
import { CHANNELS, type EffectiveChannels } from '@/shared/contracts/channels.ts';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import type { SetupFacts } from '@/shared/org-setup-checks.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { ChannelPreviews } from '@/web/channel-previews/channel-previews.tsx';
import { PassCardStage } from '@/web/pass-card/index.tsx';
import { Card, CardBody, SegmentedControl } from '@/web/ui/index.ts';
import { PassEmailPreview } from '../orgs/pass-email-preview.tsx';
import { type Draft, shownValues } from './draft.ts';
import './brand.css';
import { samplePassJson, sampleSource } from './sample-pass.ts';

type Tab = 'apple' | 'mobile' | 'google' | 'samsung' | 'paper' | 'email';
const TABS: readonly Tab[] = ['apple', 'mobile', 'google', 'samsung', 'paper', 'email'];
const COPY = PASS_SETUP_COPY.page;
const LABEL: Record<Tab, string> = {
  apple: 'Apple',
  mobile: COPY.previewPage,
  google: 'Google',
  samsung: 'Samsung',
  paper: 'Paper',
  email: COPY.previewEmail,
};

/**
 * The org's sample pass in every way it reaches a holder, redrawn as each edit is made. A channel
 * that a level stops is a locked tab that says which level. It reuses ChannelPreviews for the
 * wallets and the page, and PassEmailPreview for the email: nothing here draws a pass of its own.
 */
export function PreviewStage({
  orgId,
  view,
  draft,
  draftFacts,
  logoUrl,
  iconUrl,
  saves,
}: {
  orgId: string;
  view: PassSetup;
  draft: Draft;
  draftFacts: SetupFacts;
  logoUrl: string | undefined;
  iconUrl: string | undefined;
  /** Counts saves, so the email frame reloads. */
  saves: number;
}) {
  const [tab, setTab] = useState<Tab>('apple');
  const v = shownValues(view, draft);
  const passJson = useMemo(
    () =>
      samplePassJson({
        name: v.name,
        background: v.background,
        foreground: v.foreground,
        label: v.label,
        logoHasName: v.logoHasName,
      }),
    [v.name, v.background, v.foreground, v.label, v.logoHasName],
  );
  const assets = useMemo(
    () => ({
      ...(logoUrl ? { 'logo@2x.png': logoUrl } : {}),
      ...(iconUrl ? { 'icon@2x.png': iconUrl } : {}),
    }),
    [logoUrl, iconUrl],
  );
  const passView = useMemo(() => normalize(passJson, { assets }), [passJson, assets]);
  const source = useMemo(() => sampleSource(passJson), [passJson]);
  const effective = useMemo(
    () =>
      Object.fromEntries(
        CHANNELS.map((c) => [c, { on: draftFacts.channels[c].on, source: 'org' as const }]),
      ) as EffectiveChannels,
    [draftFacts],
  );
  const options = TABS.map((value) => {
    const row = value === 'email' ? undefined : draftFacts.channels[value];
    const stop = row && !row.on ? stoppingLevel(row.levels) : null;
    return stop
      ? {
          value,
          label: LABEL[value],
          icon: Lock,
          reason: scanLine(COPY.lockedBy, { level: PASS_SETUP_COPY.levels[stop.level] }),
        }
      : { value, label: LABEL[value] };
  });
  const current = options.find((o) => o.value === tab && !o.reason) ? tab : 'apple';
  return (
    <Card role="region" aria-label={COPY.previewTabs}>
      <CardBody className="flex flex-col items-center gap-4">
        <SegmentedControl
          label={COPY.previewTabs}
          options={options}
          value={current}
          onValueChange={setTab}
          block
          className="flex-wrap"
        />
        <div key={current} className="bc-deal w-full min-w-0">
          {current === 'email' ? (
            <PassEmailPreview orgId={orgId} buddy={v.buddy} version={saves} />
          ) : (
            <ChannelPreviews
              value={current}
              source={source}
              channels={effective}
              apple={
                <PassCardStage
                  view={passView}
                  tilt={false}
                  glow
                  mint={`${v.background}${v.foreground}${v.label}${logoUrl ?? ''}`}
                  className="mx-auto w-full max-w-60"
                />
              }
              paper={<p className="text-center text-sm text-fg-muted">{COPY.previewPaper}</p>}
            />
          )}
        </div>
      </CardBody>
    </Card>
  );
}
