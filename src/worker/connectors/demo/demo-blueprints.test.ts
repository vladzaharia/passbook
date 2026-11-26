import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import type { DatasetId } from './config.ts';
import { listRecords } from './test-kit.ts';

const templates = import.meta.glob('../../../../templates/starter-*/wallet.template.json', {
  eager: true,
  import: 'default',
}) as Record<string, { inputs: Record<string, unknown> }>;

const inputsOf = (name: string) => {
  const hit = Object.entries(templates).find(([path]) => path.includes(`/starter-${name}/`));
  if (!hit) throw new Error(`no blueprint ${name}`);
  return hit[1].inputs as { required?: string[]; properties: Record<string, object> };
};

/** The blueprints each dataset is built for (connectors design §4.1). */
const MATCHES: Record<Exclude<DatasetId, 'classic'>, string[]> = {
  'gym-members': ['monthly-pass', 'access-card', 'guest-pass'],
  'event-tickets': ['event-ticket', 'timed-ticket', 'multi-day-pass'],
  'hotel-stays': ['hotel-stay'],
  bookings: ['booking'],
  'boarding-passes': ['boarding-pass'],
  'loyalty-cards': ['store-card', 'stamp-card', 'coupon'],
  'staff-badges': ['staff-badge'],
  'transit-tickets': ['transit-ticket'],
};

describe('demo records against their blueprints', () => {
  for (const [dataset, blueprints] of Object.entries(MATCHES)) {
    for (const blueprint of blueprints) {
      it(`${dataset} fills ${blueprint}'s inputs`, async () => {
        const inputs = inputsOf(blueprint);
        const validator = new Validator(inputs as never, '2019-09', false);
        // Revision 3 at 100 % exercises the changed values too; locale varies the text.
        const sets = [
          await listRecords({ dataset, count: 60 }),
          await listRecords({ dataset, count: 60, revision: 3, changeRate: 100, locale: 'de-DE' }),
        ];
        // A plan-bound blueprint takes only the records of its plan.
        const plan = (inputs.properties.plan as { enum?: string[] } | undefined)?.enum;
        for (const rows of sets) {
          for (const row of rows.filter((r) => !(plan?.length === 1 && r.plan !== plan[0]))) {
            // The mapping picks fields by name, so only the blueprint's own keys must fit.
            const mapped = Object.fromEntries(
              Object.entries(row).filter(([k]) => k in inputs.properties),
            );
            for (const key of inputs.required ?? [])
              expect(mapped, `${key} is missing`).toHaveProperty(key);
            const result = validator.validate(mapped);
            expect(result.errors.map((e) => `${e.instanceLocation} ${e.error}`)).toEqual([]);
          }
        }
      });
    }
  }
});
