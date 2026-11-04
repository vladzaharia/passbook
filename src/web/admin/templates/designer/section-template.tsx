import { FormField, Textarea } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import { TextEdit } from './controls.tsx';

export function TemplateSection() {
  const { doc, edit } = useDesigner();
  const name = typeof doc.manifest.name === 'string' ? doc.manifest.name : '';
  const description = typeof doc.manifest.description === 'string' ? doc.manifest.description : '';
  return (
    <div className="grid gap-4">
      <TextEdit label="Name" value={name} merge="meta.name" op={(v) => ({ op: 'meta', name: v })} />
      <FormField label="Description">
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={description}
            onChange={(e) => edit({ op: 'meta', description: e.target.value }, 'meta.description')}
          />
        )}
      </FormField>
    </div>
  );
}
