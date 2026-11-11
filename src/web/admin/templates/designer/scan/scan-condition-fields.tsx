import type { ScanCond } from '@/passkit/template/scan-display/schema.ts';
import type { ScanRole } from '@/passkit/types.ts';
import { Button, FormField, Select } from '../../../../ui/index.ts';
import { isRecord } from '../model.ts';
import { ConditionLeaf } from './scan-condition-leaf.tsx';
import { conditionDepth, firstLeaf, isLeaf, type Leaf, leafCount } from './scan-condition-model.ts';
import { editorKey, useEditorKeys } from './scan-field-keys.ts';
import {
  type Manifest,
  type Option,
  type Pass,
  pickerPaths,
  scanBindingOptions,
} from './scan-fields.tsx';

function ConditionNode({
  value,
  onChange,
  options,
  manifest,
  mergeKey,
  depth,
  leaves,
}: {
  value: ScanCond;
  onChange: (value: ScanCond, merge?: string) => void;
  options: Option[];
  manifest: Manifest;
  mergeKey: string;
  depth: number;
  leaves: number;
}) {
  const paths = pickerPaths(options);
  const firstPath = [...paths][0] ?? 'holder.name';
  const fallback: Leaf = { path: firstPath, empty: false };
  const children: ScanCond[] = !isRecord(value)
    ? []
    : 'all' in value && Array.isArray(value.all)
      ? value.all
      : 'any' in value && Array.isArray(value.any)
        ? value.any
        : 'not' in value && isRecord(value.not)
          ? [value.not]
          : [];
  const leaf = isLeaf(value) ? value : undefined;
  const {
    keys: childKeys,
    items: keyedChildren,
    remember: rememberChildren,
  } = useEditorKeys(children);
  if (!isRecord(value) || depth > 12)
    return <p className="text-sm text-fg-muted">Custom condition preserved.</p>;
  const kind =
    'all' in value && Array.isArray(value.all)
      ? 'all'
      : 'any' in value && Array.isArray(value.any)
        ? 'any'
        : 'not' in value && isRecord(value.not)
          ? 'not'
          : leaf
            ? 'leaf'
            : 'custom';
  if (kind === 'custom')
    return <p className="text-sm text-fg-muted">Custom condition preserved.</p>;
  const updateChildren = (next: ScanCond[], merge?: string, nextKeys = childKeys) => {
    rememberChildren(next, nextKeys);
    if (kind === 'all') onChange({ all: next }, merge);
    else if (kind === 'any') onChange({ any: next }, merge);
    else if (kind === 'not' && next[0]) onChange({ not: next[0] }, merge);
  };
  return (
    <div className="grid gap-3 rounded-md border border-border p-3">
      {depth > 2 ? <p className="text-xs text-fg-muted">Custom condition · nested rule</p> : null}
      <FormField label={depth === 1 ? 'Match' : `Rule ${depth} match`}>
        {(control) => (
          <Select
            {...control}
            value={kind}
            options={[
              { value: 'leaf', label: 'One test' },
              {
                value: 'all',
                label: 'All tests',
                disabled: depth >= 4 || (kind === 'not' && depth + conditionDepth(value) > 4),
              },
              {
                value: 'any',
                label: 'Any test',
                disabled: depth >= 4 || (kind === 'not' && depth + conditionDepth(value) > 4),
              },
              {
                value: 'not',
                label: 'Not',
                disabled: depth >= 4 || depth + conditionDepth(value) > 4,
              },
            ]}
            onValueChange={(next) => {
              if (next === 'leaf') onChange(firstLeaf(value, fallback));
              else if (next === 'not') onChange({ not: value });
              else if (next === 'all')
                onChange({ all: kind === 'not' ? [value] : children.length ? children : [value] });
              else if (next === 'any')
                onChange({ any: kind === 'not' ? [value] : children.length ? children : [value] });
            }}
          />
        )}
      </FormField>
      {kind === 'leaf' && leaf ? (
        <ConditionLeaf
          value={leaf}
          onChange={onChange}
          options={options}
          manifest={manifest}
          mergeKey={mergeKey}
        />
      ) : (
        <>
          {keyedChildren.map(({ value: child, key }, index) => (
            <div key={key} className="grid gap-2">
              <ConditionNode
                value={child}
                options={options}
                manifest={manifest}
                mergeKey={`${mergeKey}:${index}`}
                depth={depth + 1}
                leaves={leaves}
                onChange={(updated, merge) =>
                  updateChildren(
                    children.map((item, i) => (i === index ? updated : item)),
                    merge,
                  )
                }
              />
              {kind !== 'not' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="justify-self-start"
                  disabled={children.length <= 1}
                  onClick={() =>
                    updateChildren(
                      children.filter((_, i) => i !== index),
                      undefined,
                      childKeys.filter((_, i) => i !== index),
                    )
                  }
                >
                  Remove test {index + 1}
                </Button>
              ) : null}
            </div>
          ))}
          {kind !== 'not' ? (
            <Button
              size="sm"
              variant="outline"
              className="justify-self-start"
              disabled={children.length >= 12 || leaves >= 12 || depth >= 4}
              onClick={() =>
                updateChildren([...children, fallback], undefined, [...childKeys, editorKey()])
              }
            >
              Add test
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

export function ScanConditionField({
  value,
  manifest,
  onChange,
  mergeKey,
  audienceRole = 'door',
  label = 'Show when',
  required = false,
  passJson,
}: {
  value: ScanCond | undefined;
  manifest: Manifest;
  onChange: (value: ScanCond | undefined, merge?: string) => void;
  mergeKey: string;
  audienceRole?: ScanRole;
  label?: string;
  required?: boolean;
  passJson?: Pass;
}) {
  const options = scanBindingOptions(manifest, audienceRole, passJson);
  const first = options.find((option) => !option.disabled)?.value ?? 'holder.name';
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg-strong">{label}</span>
        {!required ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(value ? undefined : { path: first, empty: false })}
          >
            {value ? 'Remove condition' : 'Add condition'}
          </Button>
        ) : null}
      </div>
      {value ? (
        <ConditionNode
          value={value}
          onChange={onChange}
          options={options}
          manifest={manifest}
          mergeKey={mergeKey}
          depth={1}
          leaves={leafCount(value)}
        />
      ) : required ? (
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          onClick={() => onChange({ path: first, empty: false })}
        >
          Add condition
        </Button>
      ) : (
        <p className="text-xs text-fg-muted">Always shown.</p>
      )}
    </div>
  );
}
