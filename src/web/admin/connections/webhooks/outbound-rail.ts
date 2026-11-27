import type { WizardStepDef } from '../../../ui/wizard/wizard-types.ts';

export const OUTBOUND_STEPS = [
  { id: 'where', title: 'Endpoint', heading: 'Where to send', group: 'In PassBook' },
  { id: 'events', title: 'Events', heading: 'Choose events', group: 'In PassBook' },
  { id: 'review', title: 'Review', group: 'In PassBook' },
  { id: 'secret', title: 'Secret', heading: 'Copy the secret', group: 'On your server' },
  { id: 'verify', title: 'Verify', heading: 'Check the signature', group: 'On your server' },
  { id: 'test', title: 'Test', heading: 'Send a test', group: 'On your server' },
] as const satisfies readonly WizardStepDef[];

export type OutboundStepId = (typeof OUTBOUND_STEPS)[number]['id'];

/** The first step on the server's side: everything before it is made at Create and then locked. */
export const SERVER_PHASE = OUTBOUND_STEPS.findIndex((s) => s.id === 'secret');

/** The rail: PassBook's three steps, then your server's three. Once created the first phase is locked. */
export function outboundRail(opts: {
  locked: boolean;
  summaries: Partial<Record<OutboundStepId, string | undefined>>;
}): WizardStepDef[] {
  return OUTBOUND_STEPS.map((s, i) => ({
    ...s,
    ...(opts.locked && i < SERVER_PHASE ? { locked: true } : {}),
    ...(opts.summaries[s.id] ? { summary: opts.summaries[s.id] } : {}),
  }));
}
