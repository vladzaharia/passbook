import { useMemo, useState } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { useDesigner } from '../../admin/templates/designer/context.tsx';
import { isRecord } from '../../admin/templates/designer/model.ts';
import { CodeBlock } from '../../ui/code-block.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.tsx';
import { snippetsFor } from '../playground/snippets.ts';
import { sampleOf } from './sample.ts';
import { useOpenTemplate } from './template-context.tsx';

/**
 * The Code tab (design §1.8): the template's input schema, `passbook types <id>`, and `POST
 * /passes` for the sample on screen in TypeScript, curl, Python and Go. The key is never in it.
 */
export function CodeTab() {
  const { doc } = useDesigner();
  const { id } = useOpenTemplate();
  const [tab, setTab] = useState('ts');
  const sample = sampleOf(doc);
  const snippets = useMemo(
    () => snippetsFor(id, sample, `${location.origin}/api/v1`),
    [id, sample],
  );
  const schema = JSON.stringify(isRecord(doc.manifest.inputs) ? doc.manifest.inputs : {}, null, 2);
  const panels = [
    ...snippets.map((s) => ({ value: s.lang, label: s.label, code: s.code })),
    { value: 'schema', label: 'Schema', code: schema },
    { value: 'cli', label: 'CLI', code: `passbook types ${id}` },
  ];
  return (
    <section aria-label="Code" className="mt-4 rounded-lg border border-border bg-surface p-3">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={WB_DESIGN.code.label}>
          {panels.map((p) => (
            <TabsTrigger key={p.value} value={p.value}>
              {p.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {panels.map((p) => (
          <TabsContent key={p.value} value={p.value}>
            <CodeBlock code={p.code} label={`${p.label} code`} maxHeight="max-h-80" />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
