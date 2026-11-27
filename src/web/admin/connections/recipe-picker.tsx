import { FormField, Input } from '../../ui/index.ts';

/** The secret the sender made, pasted. The guide's where-step says where to find it. */
export function SigningSecretField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  return (
    <FormField label="Signing secret" required error={error}>
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
