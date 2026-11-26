import { useMemo } from 'react';
import type { z } from 'zod';
import type { ConnectionFileSchema } from '@/shared/contracts/connection-files.ts';
import { FormField, Select } from '../../../ui/index.ts';

type Parsed = z.infer<typeof ConnectionFileSchema>;

/** The column that names each row. It keys every pass, so it is fixed once the connection exists. */
export function IdColumnField({
  file,
  value,
  onChange,
  error,
  disabled,
}: {
  file: Pick<Parsed, 'columns' | 'idCandidates'>;
  value: string;
  onChange: (pointer: string) => void;
  error?: string | undefined;
  disabled?: boolean;
}) {
  const options = useMemo(() => {
    const rank = (p: string) => {
      const i = file.idCandidates.indexOf(p);
      return i < 0 ? file.idCandidates.length : i;
    };
    return [...file.columns]
      .sort((a, b) => rank(a.pointer) - rank(b.pointer))
      .map((c) => ({ value: c.pointer, label: c.label }));
  }, [file.columns, file.idCandidates]);
  return (
    <FormField
      label="ID column"
      required
      help="Names each pass. Fixed once created."
      error={error}
      className="sm:max-w-sm"
    >
      {(c) => (
        <Select
          {...c}
          value={value || undefined}
          placeholder="Choose a column"
          disabled={disabled}
          onValueChange={onChange}
          options={options}
        />
      )}
    </FormField>
  );
}
