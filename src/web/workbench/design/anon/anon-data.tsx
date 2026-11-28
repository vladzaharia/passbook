import { Share2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { type InputSpec, readInputs } from '../../../admin/templates/designer/inputs.ts';
import { Button } from '../../../ui/button.tsx';
import { FormField } from '../../../ui/field.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs.tsx';
import { Control } from '../sample-control.tsx';
import { SampleJsonField } from '../sample-json-field.tsx';
import { useAnon } from './anon-context.tsx';

function coerce(spec: InputSpec, text: string): unknown {
  if (spec.type === 'boolean') return text === 'true';
  if (spec.type === 'number') {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) ? n : text;
  }
  return text;
}

function Form() {
  const { blueprint, values, setValues } = useAnon();
  const specs = readInputs({ ...blueprint.doc.manifest, sample: values });
  if (specs.length === 0) return <p className="text-sm text-fg-muted">{WB_DESIGN.noInputs}</p>;
  return (
    <div className="grid gap-4">
      {specs.map((spec) => (
        <FormField key={spec.name} label={spec.label} required={spec.required}>
          {({ id }) => (
            <Control
              spec={spec}
              id={id}
              disabled={false}
              onSet={(text) => setValues({ ...values, [spec.name]: coerce(spec, text) })}
            />
          )}
        </FormField>
      ))}
    </div>
  );
}

function Json() {
  const { values, setValues } = useAnon();
  return (
    <SampleJsonField
      canonical={JSON.stringify(values, null, 2)}
      disabled={false}
      onSample={setValues}
    />
  );
}

/** The sample as data (design §1.9): a form with a JSON toggle; the Design tab waits for a sign-in. */
export function AnonData(): ReactNode {
  const { blueprint, mode, setMode } = useAnon();
  return (
    <Tabs value="data" className="min-w-0">
      <div className="flex items-center gap-2 border-b border-border">
        <TabsList aria-label={WB_DESIGN.tabs.label} className="border-b-0">
          <TabsTrigger value="data">{WB_DESIGN.tabs.data}</TabsTrigger>
          <TabsTrigger value="design" disabled title={WB_DESIGN.anon.signIn}>
            {WB_DESIGN.tabs.design}
          </TabsTrigger>
        </TabsList>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto font-mono"
          aria-pressed={mode === 'json'}
          onClick={() => setMode(mode === 'json' ? 'form' : 'json')}
        >
          {'{ }'} {WB_DESIGN.json}
        </Button>
      </div>
      <TabsContent value="data" className="pt-4">
        {mode === 'json' ? <Json key={blueprint.preview.id} /> : <Form />}
      </TabsContent>
    </Tabs>
  );
}

export function ShareButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const { share } = useAnon();
  return (
    <Button
      variant="outline"
      aria-label={iconOnly ? WB_DESIGN.anon.share : undefined}
      iconStart={<Share2 aria-hidden />}
      onClick={share}
    >
      {iconOnly ? null : WB_DESIGN.anon.share}
    </Button>
  );
}
