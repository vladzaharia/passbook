import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionSetup } from '@/shared/contracts/connection-setup.ts';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { Button, CodeBlock, ConfirmDialog, toast, Wizard } from '../../ui/index.ts';
import {
  SetupSources,
  SetupSteps,
  TwoSided,
  useRotateSecret,
} from '../../ui/webhook-setup/index.ts';
import { Rich } from '../../ui/webhook-setup/rich.tsx';
import { useOrgTimeZone } from '../settings/use-org-time-zone.ts';
import { useConnectionActions } from './api.ts';
import { providerOrder, railSteps } from './create-wizard-steps.ts';
import { exampleBody } from './payload-example.ts';
import { ProviderPanel, ProviderStrip } from './provider-panel.tsx';
import { signingSecretError } from './recipe-copy.ts';
import { SecretStep } from './secret-step.tsx';
import { SendSnippets } from './send-snippets.tsx';
import { arrivalLoader } from './setup-api.ts';
import { SetupFinish } from './setup-finish.tsx';
import { dropSecret, heldSecret } from './setup-handoff.ts';
import { generateSecret } from './webhook.tsx';

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
}: {
  connection: Detail;
  setup: ConnectionSetup;
  sourceLabel?: string | undefined;
}) {
  const navigate = useNavigate();
  const zone = useOrgTimeZone(connection.orgId);
  const actions = useConnectionActions(connection.id);
  const { origin } = setup.secret;
  const provider = setup.provider.name;
  const order = providerOrder(origin);
  const [held, setHeld] = useState(() => heldSecret(connection.id));
  const [at, setAt] = useState(() => (held || !setup.values.hasSecret ? 0 : order.length - 1));
  const [replacing, setReplacing] = useState(false);
  const [pasted, setPasted] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [finished, setFinished] = useState(false);
  const [seen, setSeen] = useState<string[]>([]);
  const [verified, setVerified] = useState(connection.firstVerifiedArrivalAt !== null);
  const id = order[at] ?? 'test';
  const hasSecret = setup.values.hasSecret;
  const secretAt = order.indexOf('secret');
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

  async function savePasted(): Promise<void> {
    if (pasteError) return;
    try {
      await actions.update.mutateAsync({ webhookSecret: pasted.trim() });
      setPasted('');
      setReplacing(false);
      setAt((n) => Math.min(n + 1, order.length - 1));
    } catch (cause) {
      toast.error(cause, 'The secret was not saved');
    }
  }

  function next(): boolean | undefined {
    if (id === 'connect') setAt(at + 1);
    else if (id === 'test') setFinished(true);
    else if (origin === 'provider' && (!hasSecret || replacing)) {
      if (pasteError) return false;
      void savePasted();
    } else setAt(at + 1);
    return undefined;
  }

  if (finished)
    return (
      <SetupFinish
        provider={provider}
        topics={setup.subscriptions.topics}
        seen={seen}
        onOpen={open}
        onAnother={() => void navigate({ to: '/admin/connections/new' })}
      />
    );

  const guideSteps = custom ? setup.steps.filter((s) => s.id !== 'send') : setup.steps;
  const connect = (
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
      />
    </div>
  );
  const secret = (
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
      onCopied={() => {
        dropSecret(connection.id);
        setHeld(undefined);
        setAt((n) => Math.min(n + 1, order.length - 1));
      }}
      onRotated={() => {
        rotate.reset();
        setAt((n) => Math.min(n + 1, order.length - 1));
      }}
    />
  );
  const test = (
    <div className="flex max-w-[40rem] flex-col gap-3">
      <p className="text-sm text-fg">
        <Rich text={setup.test.text} />
      </p>
      {setup.test.command ? (
        <CodeBlock code={setup.test.command} label="Test command" maxHeight="max-h-24" />
      ) : null}
      <div>
        <Button variant="ghost" size="sm" onClick={open}>
          Skip for now
        </Button>
      </div>
    </div>
  );

  const waiting = origin === 'passbook' && id === 'secret' && Boolean(held);
  const label =
    id === 'test'
      ? 'Done'
      : id === 'secret' && origin === 'provider' && (!hasSecret || replacing)
        ? 'Save secret'
        : 'Next';
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
        nextDisabled={waiting || (id === 'test' && !verified)}
        nextHint={waiting ? 'Copy the secret.' : 'Waiting for a delivery.'}
        busy={actions.update.isPending}
      >
        <TwoSided
          guide={id === 'connect' ? connect : id === 'secret' ? secret : test}
          panel={
            <ProviderPanel
              setup={setup}
              connection={connection}
              load={load}
              zone={zone}
              onState={(s) => {
                setSeen((prev) =>
                  s.seen.every((t) => prev.includes(t)) ? prev : [...new Set([...prev, ...s.seen])],
                );
                if (s.verified) setVerified(true);
              }}
              seen={seen}
              onFix={goSecret}
              onTurnOn={() =>
                actions.update.mutate(
                  { config: { ...connection.config, acceptTestEvents: true } },
                  { onSuccess: () => toast.success('Test events on') },
                )
              }
              onFailures={open}
            />
          }
          strip={
            <ProviderStrip
              url={url}
              seen={seen}
              topics={setup.subscriptions.topics}
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
