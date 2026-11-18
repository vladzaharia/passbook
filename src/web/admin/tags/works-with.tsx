import { TAG_COPY } from '@/shared/copy/tags.ts';
import { RadioGroup } from '@/web/ui/index.ts';
import { fill } from './words.ts';

export type WorksWith = 'pass' | 'person';

/**
 * Whether a tag works with one pass or all the holder's. The person-wide choice is open whenever
 * the holder has an account, so it also covers passes they get later.
 */
export function WorksWithChoice({
  name,
  hasAccount,
  value,
  onChange,
}: {
  name: string;
  hasAccount: boolean;
  value: WorksWith;
  onChange: (value: WorksWith) => void;
}) {
  return (
    <RadioGroup
      legend="Works with"
      value={hasAccount ? value : 'pass'}
      onValueChange={(v) => onChange(v as WorksWith)}
      options={[
        {
          value: 'person',
          label: fill(TAG_COPY.worksWith.person, { name }),
          hint: hasAccount ? undefined : TAG_COPY.noAccount,
          disabled: !hasAccount,
        },
        { value: 'pass', label: TAG_COPY.worksWith.pass },
      ]}
    />
  );
}
