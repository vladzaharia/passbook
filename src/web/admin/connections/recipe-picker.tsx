import { Webhook } from 'lucide-react';
import type { RecipeId, RecipeInfo } from '@/shared/contracts/connections.ts';
import { FormField, Input, OptionTile } from '../../ui/index.ts';
import { RECIPE_COPY, recipeLine } from './recipe-copy.ts';

/** Who sends the webhooks. Fixed once the connection exists. */
export function RecipePicker({
  recipes,
  customEntitled = true,
  value,
  onChange,
}: {
  recipes: readonly RecipeInfo[];
  /** False when the plan lists senders but not a custom one. */
  customEntitled?: boolean;
  value: RecipeId;
  onChange: (id: RecipeId) => void;
}) {
  const options = [
    ...(customEntitled ? [{ id: 'custom' as RecipeId, label: 'Custom' }] : []),
    ...recipes.filter((r) => r.entitled !== false),
  ];
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-medium text-fg">Sender</legend>
      <div
        role="radiogroup"
        aria-label="Sender"
        className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-2"
      >
        {options.map((r) => (
          <OptionTile
            key={r.id}
            name="webhook-sender"
            value={r.id}
            label={r.label}
            description={recipeLine(r.id)}
            icon={Webhook}
            checked={value === r.id}
            onSelect={(v) => onChange(v as RecipeId)}
          />
        ))}
      </div>
    </fieldset>
  );
}

/** Shopify and Stripe make the secret; paste it here. */
export function SigningSecretField({
  recipe,
  value,
  onChange,
  error,
}: {
  recipe: Exclude<RecipeId, 'custom'>;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  return (
    <FormField label="Signing secret" required help={RECIPE_COPY[recipe].secretHelp} error={error}>
      {(c) => (
        <Input
          {...c}
          type="password"
          className="font-mono sm:max-w-md"
          autoComplete="off"
          spellCheck={false}
          maxLength={256}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FormField>
  );
}
