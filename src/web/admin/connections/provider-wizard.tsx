import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionSetup } from '@/shared/contracts/connection-setup.ts';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { copyText } from '../../lib/clipboard.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { CodeBlock, ConfirmDialog, toast, Wizard } from '../../ui/index.ts';
import type { SetupTopic } from '../../ui/webhook-setup/index.ts';
import {
  SetupFinish,
  SetupSources,
  SetupSteps,
  TwoSided,
  topicProgress,
  useRotateSecret,
} from '../../ui/webhook-setup/index.ts';
import { useOrgTimeZone } from '../settings/use-org-time-zone.ts';
import { useTemplate } from '../templates/api.ts';
import { useConnectionActions } from './api.ts';
import { providerGroup, providerOrder, railSteps } from './create-wizard-steps.ts';
import { exampleBody } from './payload-example.ts';
import { ProviderLive, ProviderPanel, ProviderStrip } from './provider-panel.tsx';
import { signingSecretError } from './recipe-copy.ts';
import { SecretStep } from './secret-step.tsx';
import { SendSnippets } from './send-snippets.tsx';
import { arrivalLoader, useNotIssued } from './setup-api.ts';
import { dropSecret, heldSecret } from './setup-handoff.ts';
import { generateSecret } from './webhook.tsx';

/** What the test saw, in lines: the signature, the topics and what the connection issues. */
function finishFacts(
  topics: readonly SetupTopic[],
  seen: readonly string[],
  issues: string | undefined,
): string[] {
  const progress = topicProgress(topics, seen);
  const missing = topics.filter((t) => t.required && !seen.includes(t.id)).map((t) => t.id);
  return [
    'Signature OK',
    ...(progress.of > 0
      ? [
          progress.seen >= progress.of
            ? `${progress.seen} of ${progress.of} required topics seen`
            : `${progress.seen} of ${progress.of} seen · ${missing.join(', ')} not seen yet`,
        ]
      : []),
    ...(issues ? [`Issues: ${issues}`] : []),
  ];
}

type Detail = z.infer<typeof ConnectionDetailSchema>;
type Overlap = 0 | 3600 | 86_400 | 604_800;
const FIRST_PHASE = 5;

/**
 * The provider's side of a webhook: the first phase is done and locked (it is edited on the
 * connection); this one adds the webhook there, settles the secret and waits for a delivery.
 * Everything is read from the server, so the page resumes from any state.
 */
export function ProviderWizard({
  connection,
  setup,
  sourceLabel,
  openAt,
}: {
  connection: Detail;
  setup: ConnectionSetup;
  sourceLabel?: string | undefined;
  /** Open at the Secret step (a fix on the connection page sends people here). */
  openAt?: 'secret' | undefined;
}) {
  const navigate = useNavigate();
  const zone = useOrgTimeZone(connection.orgId);
  const actions = useConnectionActions(connection.id);
  const { membership } = useOrgScope();
  const { origin } = setup.secret;
  const provider = setup.provider.name;
  const order = providerOrder(origin);
  const secretAt = order.indexOf('secret');
  const [held, setHeld] = useState(() => heldSecret(connection.id));
  const [at, setAt] = useState(() =>
    openAt === 'secret' ? secretAt : held || !setup.values.hasSecret ? 0 : order.length - 1,
  );
  const [replacing, setReplacing] = useState(openAt === 'secret');
  const [saved, setSaved] = useState(false);
  const [pasted, setPasted] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [finished, setFinished] = useState(false);
  const [seen, setSeen] = useState<string[]>([]);
  const [verified, setVerified] = useState(connection.firstVerifiedArrivalAt !== null);
  const id = order[at] ?? 'test';
  const hasSecret = setup.values.hasSecret;
  const pasteError = signingSecretError(setup.secret, pasted, provider);
  const rotate = useRotateSecret(async (hours) => {
    const secret = generateSecret();
    await actions.update.mutateAsync({
      webhookSecret: secret,
      overlapSeconds: (hours * 3600) as Overlap,
    });
    return { secret };
  });
  const load = useMemo(() => arrivalLoader(connection.id), [connection.id]);
  const notIssued = useNotIssued(connection.id);
  const templateOrg = membership?.capabilities.includes('templates:read')
    ? connection.orgId
    : undefined;
  const template = useTemplate(
    templateOrg ? (connection.defaultTemplateId ?? undefined) : undefined,
    templateOrg,
  );
  const url = setup.values.endpointUrl ?? '';
  const custom = setup.recipe === 'custom';

  const open = () =>
    void navigate({
      to: '/admin/connections/$connectionId',
      params: { connectionId: connection.id },
      replace: true,
    });
  const goSecret = () => {
    setReplacing(true);
    setAt(secretAt);
  };
  const advance = () => setAt((n) => Math.min(n + 1, order.length - 1));

  async function savePasted(): Promise<void> {
    if (pasteError) return;
    try {
      await actions.update.mutateAsync({ webhookSecret: pasted.trim() });
      setPasted('');
      setReplacing(false);
      advance();
    } catch (cause) {
      toast.error(cause, 'The secret was not saved');
    }
  }

  const holding = origin === 'passbook' && id === 'secret' && Boolean(held);
  function next(): boolean | undefined {
    if (id === 'test') setFinished(true);
    else if (holding) {
      dropSecret(connection.id);
      setHeld(undefined);
      setSaved(false);
      advance();
    } else if (id === 'secret' && origin === 'provider' && (!hasSecret || replacing)) {
      if (pasteError) return false;
      void savePasted();
    } else advance();
    return undefined;
  }

  if (finished)
    return (
      <SetupFinish
        title={`${provider} is connected`}
        facts={finishFacts(setup.subscriptions.topics, seen, template.data?.name)}
        openLabel="Open connection"
        onOpen={open}
        onAnother={() => void navigate({ to: '/admin/connections/new' })}
      />
    );

  const live = (withHint: boolean) => (
    <ProviderLive
      setup={setup}
      connection={connection}
      load={load}
      zone={zone}
      notIssued={notIssued}
      withHint={withHint}
      onState={(s) => {
        setSeen((prev) =>
          s.seen.every((t) => prev.includes(t)) ? prev : [...new Set([...prev, ...s.seen])],
        );
        if (s.verified) setVerified(true);
      }}
      actions={{
        replaceSecret: goSecret,
        goToSecret: goSecret,
        turnOnTestEvents: () =>
          actions.update.mutate(
            { config: { ...connection.config, acceptTestEvents: true } },
            { onSuccess: () => toast.success('Test events on') },
          ),
        openFailures: open,
      }}
    />
  );

  // The Secret and Test steps have their own pages: Connect shows the rest of the guide.
  const guideSteps = setup.steps.filter(
    (s) => s.id !== setup.secret.whereStep && !['test', 'send'].includes(s.id),
  );
  const labelsMayDiffer =
    setup.steps.some((s) => s.verified === false) ||
    setup.subscriptions.topics.some((t) => t.verified === false);
  const connectGuide = (
    <div className="flex min-w-0 flex-col gap-6">
      <SetupSteps
        steps={guideSteps}
        values={{
          endpointUrl: url,
          ...(setup.values.signatureHeader
            ? { signatureHeader: setup.values.signatureHeader }
            : {}),
          ...(setup.values.timestampHeader
            ? { timestampHeader: setup.values.timestampHeader }
            : {}),
        }}
        topics={setup.subscriptions.topics}
        storageKey={`wallet-setup:${connection.id}`}
      />
      {custom ? (
        <SendSnippets
          url={url}
          signatureHeader={setup.values.signatureHeader}
          timestampHeader={setup.values.timestampHeader}
          body={exampleBody(connection.config)}
        />
      ) : null}
      <SetupSources
        provider={provider}
        consoleUrl={setup.provider.consoleUrl}
        docs={setup.provider.docs}
        checkedAt={setup.checkedAt}
        labelsMayDiffer={labelsMayDiffer}
      />
    </div>
  );
  const secretGuide = (
    <SecretStep
      setup={setup}
      held={held}
      hasSecret={hasSecret}
      replacing={replacing}
      onReplace={() => setReplacing(true)}
      pasted={pasted}
      onPaste={setPasted}
      pasteError={pasteError}
      rotate={rotate}
      saved={saved}
      onSaved={setSaved}
      onRotated={() => {
        rotate.reset();
        advance();
      }}
    />
  );
  // The test leads with its result: at every width it is on the page, not behind a disclosure.
  const testGuide = (
    <div className="flex max-w-xl min-w-0 flex-col gap-4">
      {live(true)}
      {setup.test.command ? (
        <CodeBlock code={setup.test.command} label="Test command" maxHeight="max-h-24" wrap />
      ) : null}
    </div>
  );

  const label =
    id === 'test'
      ? 'Done'
      : id === 'secret' && origin === 'provider' && (!hasSecret || replacing)
        ? 'Save secret'
        : 'Next';
  const barMenu =
    id === 'connect'
      ? [{ label: 'Copy URL', phoneOnly: true, onSelect: () => void copyText(url, 'URL') }]
      : id === 'test' && !verified
        ? [{ label: 'Skip for now', onSelect: open }]
        : [];
  return (
    <>
      <Wizard
        steps={railSteps({ provider, origin, locked: true, summary: sourceLabel })}
        current={FIRST_PHASE + at}
        onStep={(i) => i >= FIRST_PHASE && setAt(i - FIRST_PHASE)}
        lockedReason="Change this on the connection."
        onCancel={() => setLeaving(true)}
        onBack={at > 0 ? () => setAt(at - 1) : undefined}
        onNext={next}
        nextLabel={label}
        nextDisabled={(holding && !saved) || (id === 'test' && !verified)}
        nextHint={holding ? 'Copy the secret.' : 'Waiting for a delivery.'}
        barMenu={barMenu}
        busy={actions.update.isPending}
      >
        <TwoSided
          guideLabel={providerGroup(provider)}
          guide={id === 'connect' ? connectGuide : id === 'secret' ? secretGuide : testGuide}
          panel={
            <ProviderPanel setup={setup} seen={seen} live={id === 'test' ? null : live(false)} />
          }
          strip={
            <ProviderStrip
              url={url}
              topics={setup.subscriptions.topics}
              seen={seen}
              verified={verified}
            />
          }
        />
      </Wizard>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title="Leave setup?"
        description={`The connection stays, waiting for ${provider}.`}
        confirmLabel="Leave"
        cancelLabel="Keep setting up"
        onConfirm={open}
      />
    </>
  );
}
