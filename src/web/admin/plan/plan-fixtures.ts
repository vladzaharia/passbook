import type { OrgPlanDto } from '@/shared/contracts/org-plan.ts';

export const planFixture = (over: Partial<OrgPlanDto> = {}): OrgPlanDto => ({
  orgId: 'o1',
  preset: 'standard',
  label: 'Standard',
  limits: [
    { key: 'passes.live', limit: 5000, used: 3214 },
    { key: 'templates', limit: 25, used: 4 },
    { key: 'scanning.devices', limit: 20, used: 19 },
    { key: 'members', limit: null, used: 2 },
    { key: 'email.perDay', limit: 500, used: null },
  ],
  features: [
    { key: 'apple', level: null },
    { key: 'wallet.google', level: null },
    { key: 'nfc', level: 'basic' },
    { key: 'api', level: 'read' },
  ],
  footer: 'quiet',
  ...over,
});
