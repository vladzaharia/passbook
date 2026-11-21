import { ScanSetupIntentSchema } from './contracts/scan-setup-intent.ts';
import { planScanSetup } from './scan-setup-plan.ts';
import type { SetupPlanContext } from './scan-setup-plan-types.ts';

export const ORG = 'org_1';
/** Ids carry `_`, so none of them reads as a ref. */
export const ctxOf = (over: Partial<SetupPlanContext> = {}): SetupPlanContext => ({
  mode: 'live',
  orgTimeZone: 'Europe/Berlin',
  templates: [
    { id: 'tpl_day', name: 'Day pass', plans: null, issued: { live: 4, test: 0 } },
    {
      id: 'tpl_gym',
      name: 'Monthly',
      plans: [
        {
          id: 'gym',
          label: 'Gym',
          zones: ['gym'],
          hours: { mon: ['06:00-22:00'], sat: ['08:00-12:00'] },
        },
      ],
      issued: { live: 10, test: 2 },
    },
    { id: 'tpl_ticket', name: 'Ticket', plans: null, issued: { live: 0, test: 0 } },
  ],
  zones: [
    {
      id: 'zone_gym',
      key: 'gym',
      name: 'Gym',
      parentId: null,
      archived: false,
      occupancy: 'track',
      capacity: 60,
    },
    {
      id: 'zone_old',
      key: 'old',
      name: 'Old',
      parentId: null,
      archived: true,
      occupancy: 'off',
      capacity: null,
    },
  ],
  events: [
    {
      id: 'event_gala',
      name: 'Gala',
      templateIds: ['tpl_ticket'],
      reentry: false,
      capacity: null,
    },
  ],
  staff: [],
  ...over,
});

/** Parses like the route does, then plans. */
export function plan(intent: Record<string, unknown>, ctx = ctxOf()) {
  return planScanSetup(ScanSetupIntentSchema.parse({ orgId: ORG, ...intent }), ctx);
}

export function planned(intent: Record<string, unknown>, ctx = ctxOf()) {
  const result = plan(intent, ctx);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.plan;
}

export const codes = (intent: Record<string, unknown>, ctx = ctxOf()) => {
  const result = plan(intent, ctx);
  return result.ok ? [] : result.issues.map((i) => i.code);
};
