import { useMemo } from 'react';
import { FormField } from '../../../ui/index.ts';
import { DateTimeInput } from '../../passes/schema-form/datetime-input.tsx';
import { validateValues } from '../../passes/schema-form/index.ts';
import { ListInput } from '../../passes/schema-form/list-input.tsx';
import { useDesigner } from './context.tsx';
import { type ListKey, listOf } from './ops-more.ts';
import { relevanceField, relevanceSchema } from './relevance-schema.ts';

function ListEditor({ list }: { list: ListKey }) {
  const { doc, edit } = useDesigner();
  const field = useMemo(() => relevanceField(list), [list]);
  const items = listOf(doc, list);
  const errors = useMemo(
    () => validateValues(relevanceSchema(list), { [list]: items }),
    [list, items],
  );
  return (
    <section aria-label={field.label} data-target={`relevance:${list}`} tabIndex={-1}>
      <ListInput
        field={field}
        value={items}
        onValue={(rows) =>
          // Typing coalesces into one undo step; adding and removing are their own.
          edit(
            { op: 'list', key: list, items: rows ?? [] },
            rows?.length === items.length ? list : undefined,
          )
        }
        errors={errors}
        maxImageBytes={0}
      />
    </section>
  );
}

export function RelevanceSection() {
  const { doc, edit } = useDesigner();
  const expiry = typeof doc.passJson.expirationDate === 'string' ? doc.passJson.expirationDate : '';
  return (
    <div className="grid gap-6">
      <ListEditor list="locations" />
      <ListEditor list="beacons" />
      <ListEditor list="relevantDates" />
      <section aria-label="Expiry" className="grid gap-3">
        <h3 className="text-sm font-semibold text-fg-strong">Expiry</h3>
        <FormField label="Expires">
          {(control) => (
            <DateTimeInput
              {...control}
              value={expiry}
              clearLabel="Never expires"
              onValue={(v) => edit({ op: 'pass-prop', key: 'expirationDate', value: v }, 'expires')}
              onBlur={() => undefined}
            />
          )}
        </FormField>
      </section>
    </div>
  );
}
