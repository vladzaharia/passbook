import { useMemo, useState } from 'react';
import { CHANNELS, type EffectiveChannels } from '@/shared/contracts/channels.ts';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import type { SetupFacts } from '@/shared/org-setup-checks.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import { ChannelPreviews } from '@/web/channel-previews/channel-previews.tsx';
import { PaperChannel } from '@/web/channel-previews/channel-stage.tsx';
import type { PreviewSource } from '@/web/channel-previews/types.ts';
import { PassCardStage } from '@/web/pass-card/index.tsx';
import { Card, CardBody, SegmentedControl } from '@/web/ui/index.ts';
import { PassEmailPreview } from '../orgs/pass-email-preview.tsx';
import { useTemplate } from '../templates/api.ts';
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

/**
 * The org's sample pass in every way it reaches a holder, redrawn as each edit is made. A channel
 * PassBook, the plan or the organization stops has no tab, as in every preview switcher. It reuses
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
  const options = TABS.filter((t) => t === 'email' || draftFacts.channels[t].on).map((value) => ({
    value,
    label: LABEL[value],
  }));
  // A channel the draft blocks loses its tab: the preview moves to the first.
  const current = options.some((o) => o.value === tab) ? tab : (options[0]?.value ?? 'email');
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
          ) : current === 'paper' ? (
            <PaperChannel source={paperSource} templateId={view.templates[0]?.id} orgId={orgId} />
          ) : (
            <ChannelPreviews
              value={current}
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
