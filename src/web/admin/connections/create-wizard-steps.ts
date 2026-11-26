import type { WizardStepDef } from '../../ui/wizard/wizard-types.ts';

/** Who makes the signing secret: it sets the order of the provider's steps. */
export type SecretOrigin = 'provider' | 'passbook';

export const PASSBOOK_STEPS = [
  { id: 'connector', title: 'Source' },
  { id: 'config', title: 'Setup' },
  { id: 'mapping', title: 'Mapping' },
  { id: 'lifecycle', title: 'Issuing' },
  { id: 'review', title: 'Review' },
] as const;

type ProviderStepId = 'connect' | 'secret' | 'test';

/** The sender's own secret is pasted after the webhook exists there; ours is copied before it. */
export const providerOrder = (origin: SecretOrigin): ProviderStepId[] =>
  origin === 'provider' ? ['connect', 'secret', 'test'] : ['secret', 'connect', 'test'];

const HEADING: Record<SecretOrigin, Record<ProviderStepId, string>> = {
  provider: { connect: 'Add the webhook', secret: 'Paste the secret', test: 'Send a test' },
  passbook: { connect: 'Add the webhook', secret: 'Copy the secret', test: 'Send a test' },
};
const CUSTOM = 'Your system';
const TITLE: Record<ProviderStepId, string> = {
  connect: 'Connect',
  secret: 'Secret',
  test: 'Test',
};

/** "In Shopify"; the custom sender is "Your system". */
export const providerGroup = (name: string) =>
  name === 'Your system' ? 'In your system' : `In ${name}`;

/** The two-phase rail: PassBook's five steps, then the provider's three. */
export function railSteps({
  provider,
  origin,
  locked,
  summary,
}: {
  provider: string;
  origin: SecretOrigin;
  /** The connection exists: the first phase is done and edited on the connection. */
  locked: boolean;
  /** What was chosen at Source ("Shopify orders"). */
  summary?: string | undefined;
}): WizardStepDef[] {
  const first: WizardStepDef[] = PASSBOOK_STEPS.map((s, i) => ({
    ...s,
    group: 'In PassBook',
    ...(locked ? { locked: true } : {}),
    ...(i === 0 && summary ? { summary } : {}),
  }));
  const second: WizardStepDef[] = providerOrder(origin).map((id) => ({
    id,
    title: TITLE[id],
    heading: id === 'connect' && provider === CUSTOM ? 'Sign and send' : HEADING[origin][id],
    group: providerGroup(provider),
  }));
  return [...first, ...second];
}
