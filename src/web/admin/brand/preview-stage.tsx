import { Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { stoppingLevel } from '@/shared/channels.ts';
import { CHANNELS, type EffectiveChannels } from '@/shared/contracts/channels.ts';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { channelStatusLine, PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import type { SetupFacts } from '@/shared/org-setup-checks.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { ChannelPreviews } from '@/web/channel-previews/channel-previews.tsx';
import { PaperChannel } from '@/web/channel-previews/channel-stage.tsx';
import { LockedPreview } from '@/web/channel-previews/locked-preview.tsx';
import type { PreviewSource } from '@/web/channel-previews/types.ts';
import { PassCardStage } from '@/web/pass-card/index.tsx';
import { Card, CardBody, SegmentedControl } from '@/web/ui/index.ts';
import { PassEmailPreview } from '../orgs/pass-email-preview.tsx';
import { useTemplate } from '../templates/api.ts';
import { AskPassbook } from './channel-row.tsx';
import './brand.css';
import { type Draft, shownValues } from './draft.ts';
import { type SampleImage, samplePassJson, sampleSource } from './sample-pass.ts';

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

/** The sample pass the previews and the holder dialog draw: colours, name and the org's images. */
export function useSample(
  view: PassSetup,
  draft: Draft,
  logo: SampleImage | undefined,
  icon: SampleImage | undefined,
  template?: Parameters<typeof sampleSource>[2],
) {
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
  const source = useMemo(
    () => sampleSource(passJson, { logo, icon }, template),
    [passJson, logo, icon, template],
  );
  const passView = useMemo(
    () => normalize(passJson, { assets: source.assetUrls ?? {} }),
    [passJson, source],
  );
  return { passJson, source, passView, mint: `${v.background}${v.foreground}${v.label}` };
}

/** A channel a level stops: the card greyed under the reason, the stopping level, and where to ask. */
function LockedPane({
  channel,
  row,
  card,
  orgName,
}: {
  channel: Exclude<Tab, 'email'>;
  row: SetupFacts['channels'][Exclude<Tab, 'email'>];
  card: React.ReactNode;
  orgName: string;
}) {
  const stop = stoppingLevel(row.levels);
  return (
    <LockedPreview
      title={`${CHANNEL_LABEL[channel]}: ${channelStatusLine({ levels: row.levels, templates: row.templates })}`}
      level={stop?.level ?? 'org'}
      card={card}
    >
      {stop?.level === 'plan' ? <AskPassbook channel={channel} orgName={orgName} /> : null}
    </LockedPreview>
  );
}

/**
 * The org's sample pass in every way it reaches a holder, redrawn as each edit is made. A channel
 * that a level stops is a locked tab whose card is greyed under the reason. It reuses
 * ChannelPreviews for the wallets and the page, PaperChannel for Paper and PassEmailPreview for
 * the email: nothing here draws a pass of its own.
 */
export function PreviewStage({
  orgId,
  view,
  draft,
  draftFacts,
  sample,
  saves,
}: {
  orgId: string;
  view: PassSetup;
  draft: Draft;
  draftFacts: SetupFacts;
  sample: ReturnType<typeof useSample>;
  /** Counts saves, so the email frame reloads. */
  saves: number;
}) {
  const [tab, setTab] = useState<Tab>('apple');
  const v = shownValues(view, draft);
  const template = useTemplate(view.templates[0]?.id, orgId).data;
  const paperSource = useMemo<PreviewSource>(
    () => ({
      ...sample.source,
      manifest: (template?.manifest ?? sample.source.manifest) as Record<string, unknown>,
      input: template?.sample ?? sample.source.input,
    }),
    [sample.source, template],
  );
  const effective = useMemo(
    () =>
      Object.fromEntries(
        CHANNELS.map((c) => [c, { on: draftFacts.channels[c].on, source: 'org' as const }]),
      ) as EffectiveChannels,
    [draftFacts],
  );
  const card = (
    <PassCardStage
      view={sample.passView}
      tilt={false}
      glow
      mint={sample.mint}
      className="mx-auto w-full max-w-60"
    />
  );
  const options = TABS.map((value) => {
    const row = value === 'email' ? undefined : draftFacts.channels[value];
    return row && !row.on
      ? { value, label: LABEL[value], icon: Lock }
      : { value, label: LABEL[value] };
  });
  const row = tab === 'email' ? undefined : draftFacts.channels[tab];
  return (
    <Card role="region" aria-label={COPY.previewTabs}>
      <CardBody className="flex flex-col items-center gap-4">
        <SegmentedControl
          label={COPY.previewTabs}
          options={options}
          value={tab}
          onValueChange={setTab}
          block
          className="flex-wrap"
        />
        <div key={tab} className="bc-deal w-full min-w-0">
          {tab === 'email' ? (
            <PassEmailPreview orgId={orgId} buddy={v.buddy} version={saves} />
          ) : row && !row.on ? (
            <LockedPane channel={tab} row={row} card={card} orgName={v.name} />
          ) : tab === 'paper' ? (
            <PaperChannel source={paperSource} templateId={view.templates[0]?.id} orgId={orgId} />
          ) : (
            <ChannelPreviews
              value={tab}
              source={sample.source}
              channels={effective}
              apple={card}
              paper={null}
            />
          )}
        </div>
      </CardBody>
    </Card>
  );
}
