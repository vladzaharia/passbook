import type { Journey } from '../lib/journey.ts';
import { bundles } from './bundles.ts';
import { connectionsWebhooks } from './connections-webhooks.ts';
import { importJourney } from './import.ts';
import { join } from './join.ts';
import { messages } from './messages.ts';
import { onboardingSignin } from './onboarding-signin.ts';
import { passLifecycle } from './pass-lifecycle.ts';
import { retention } from './retention.ts';

/** In the order of the vertical passes plan. */
export const journeys: Journey[] = [
  passLifecycle,
  join,
  importJourney,
  connectionsWebhooks,
  messages,
  onboardingSignin,
  retention,
  bundles,
];
