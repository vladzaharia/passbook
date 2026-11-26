import type { RecipeId } from '@/shared/contracts/connections.ts';
import { FormField, Input } from '../../ui/index.ts';
import { RECIPE_COPY } from './recipe-copy.ts';

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
