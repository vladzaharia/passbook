import type { SessionCustomerSettings } from '@/shared/contracts/scanning-sessions.ts';
import { CUSTOMER_COPY } from '@/shared/copy/scan-customer.ts';
import { DependentSettings, FormField, Input, SwitchRow } from '@/web/ui/index.ts';

/** What the session's customer screens say. Empty lines keep the defaults. */
export function SessionCustomerFields({
  value,
  onChange,
  desk,
}: {
  /** Desk actions are on: the desk card only shows for them. */
  desk: boolean;
  value: SessionCustomerSettings | undefined;
  onChange: (next: SessionCustomerSettings) => void;
}) {
  const c = value ?? {};
  const set = (patch: SessionCustomerSettings) => onChange({ ...c, ...patch });
  return (
    <div className="grid gap-4">
      <FormField
        label="Welcome"
        help={`The idle line. Up to 40 characters. Empty: ${CUSTOMER_COPY.welcome}.`}
      >
        {(p) => (
          <Input
            {...p}
            maxLength={40}
            placeholder={CUSTOMER_COPY.welcome}
            value={c.welcome ?? ''}
            onChange={(e) => set({ welcome: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="Refusal line">
        {(p) => (
          <Input
            {...p}
            maxLength={40}
            placeholder={CUSTOMER_COPY.refusedLine}
            value={c.refusedLine ?? ''}
            onChange={(e) => set({ refusedLine: e.target.value })}
          />
        )}
      </FormField>
      <SwitchRow
        label="Greet by first name"
        help="“Hi, Maya” on results."
        checked={c.greet ?? true}
        onCheckedChange={(greet) => set({ greet })}
      />
      <DependentSettings open={desk}>
        <SwitchRow
          label="Show the desk card"
          help="While staff choose an action: “Hi, Sam · Balance $42.50”."
          checked={c.showReady ?? true}
          onCheckedChange={(showReady) => set({ showReady })}
        />
        <SwitchRow
          label="Show amounts"
          checked={c.showDraft ?? true}
          onCheckedChange={(showDraft) => set({ showDraft })}
        />
      </DependentSettings>
    </div>
  );
}
