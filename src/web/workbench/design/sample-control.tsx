import type { InputSpec } from '../../admin/templates/designer/inputs.ts';
import { Input, Textarea } from '../../ui/input.tsx';
import { Select } from '../../ui/select.tsx';
import { Switch } from '../../ui/switch.tsx';

const HTML_TYPE: Partial<Record<InputSpec['type'], string>> = {
  email: 'email',
  url: 'url',
  number: 'text',
  datetime: 'text',
};

/** One input of the sample as its control: the Data panel here and the anonymous page share it. */
export function Control({
  spec,
  id,
  disabled,
  onSet,
}: {
  spec: InputSpec;
  id: string;
  disabled: boolean;
  onSet: (value: string) => void;
}) {
  if (spec.type === 'list') return <span id={id} />;
  if (spec.type === 'boolean')
    return (
      <Switch
        id={id}
        aria-label={spec.label}
        checked={spec.sample === 'true'}
        disabled={disabled}
        onCheckedChange={(on) => onSet(String(on))}
      />
    );
  if (spec.type === 'choice')
    return (
      <Select
        id={id}
        value={spec.sample}
        disabled={disabled}
        options={(spec.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        onValueChange={onSet}
      />
    );
  if (spec.type === 'textarea')
    return (
      <Textarea
        id={id}
        rows={3}
        value={spec.sample}
        disabled={disabled}
        onChange={(e) => onSet(e.target.value)}
      />
    );
  return (
    <Input
      id={id}
      type={HTML_TYPE[spec.type] ?? 'text'}
      inputMode={spec.type === 'number' ? 'decimal' : undefined}
      value={spec.sample}
      disabled={disabled}
      onChange={(e) => onSet(e.target.value)}
    />
  );
}
