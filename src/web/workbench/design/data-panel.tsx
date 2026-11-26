import { lazy, type ReactNode, Suspense, useState } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { useDesigner } from '../../admin/templates/designer/context.tsx';
import { type InputSpec, readInputs } from '../../admin/templates/designer/inputs.ts';
import { Button } from '../../ui/button.tsx';
import { FormField } from '../../ui/field.tsx';
import { Input, Textarea } from '../../ui/input.tsx';
import { Select } from '../../ui/select.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { Switch } from '../../ui/switch.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.tsx';
import { IssueTestPass } from './issue.tsx';

/** The JSON editor loads when its toggle first turns on. */
const SampleJson = lazy(() => import('./sample-json.tsx'));

const HTML_TYPE: Partial<Record<InputSpec['type'], string>> = {
  email: 'email',
  url: 'url',
  number: 'text',
  datetime: 'text',
};

function Control({
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
  if (spec.type === 'list')
    return (
      <span id={id} className="text-sm text-fg-muted">
        {WB_DESIGN.list}
      </span>
    );
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

/** The sample as a form: one control per input, each edit a draft change like any other. */
function SampleForm() {
  const { doc, edit, readOnly } = useDesigner();
  const specs = readInputs(doc.manifest);
  if (specs.length === 0) return <p className="text-sm text-fg-muted">{WB_DESIGN.noInputs}</p>;
  return (
    <div className="grid gap-4">
      {specs.map((spec) => (
        <FormField key={spec.name} label={spec.label} required={spec.required}>
          {({ id }) => (
            <Control
              spec={spec}
              id={id}
              disabled={readOnly}
              onSet={(value) =>
                edit(
                  { op: 'input-set', name: spec.name, patch: { sample: value } },
                  `in-sample:${spec.name}`,
                )
              }
            />
          )}
        </FormField>
      ))}
    </div>
  );
}

/**
 * The structure column in the Workbench (design §1.8): Data, the sample input with a JSON toggle,
 * beside Design, the section editor. Both stay mounted so a section opened from the card still
 * finds its control.
 */
export function DataPanel({ structure }: { structure: ReactNode }) {
  const [tab, setTab] = useState('data');
  const [json, setJson] = useState(false);
  return (
    <Tabs value={tab} onValueChange={setTab} className="min-w-0">
      <div className="flex items-center gap-2 border-b border-border">
        <TabsList aria-label={WB_DESIGN.tabs.label} className="border-b-0">
          <TabsTrigger value="data">{WB_DESIGN.tabs.data}</TabsTrigger>
          <TabsTrigger value="design">{WB_DESIGN.tabs.design}</TabsTrigger>
        </TabsList>
        {tab === 'data' ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto font-mono"
            aria-pressed={json}
            onClick={() => setJson((on) => !on)}
          >
            {'{ }'} {WB_DESIGN.json}
          </Button>
        ) : null}
      </div>
      <TabsContent value="data" forceMount hidden={tab !== 'data'}>
        {json ? (
          <Suspense
            fallback={
              <FormField label={WB_DESIGN.jsonInput}>
                {() => <Skeleton className="h-[15.25rem] w-full rounded-md" />}
              </FormField>
            }
          >
            <SampleJson />
          </Suspense>
        ) : (
          <SampleForm />
        )}
        <div className="mt-4">
          <IssueTestPass />
        </div>
      </TabsContent>
      <TabsContent value="design" forceMount hidden={tab !== 'design'}>
        {structure}
      </TabsContent>
    </Tabs>
  );
}
