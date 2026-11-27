import { useEffect } from 'react';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
import { useDesigner } from '../../admin/templates/designer/context.tsx';
import { useKept } from '../../admin/templates/designer/ui-keep.tsx';
import { FormField } from '../../ui/field.tsx';
import { Textarea } from '../../ui/input.tsx';
import { parseSample, sampleText } from './sample.ts';

/** The same sample as JSON. Text being typed stays yours; a valid object becomes the sample at once. */
export default function SampleJson() {
  const { doc, edit, readOnly } = useDesigner();
  const canonical = sampleText(doc);
  // Kept across the phone breakpoint, so text half typed there is still here after the layout comes back.
  const [text, setText] = useKept('sample-json:text', canonical);
  const [problem, setProblem] = useKept<string | null>('sample-json:problem', null);
  const [seen, setSeen] = useKept('sample-json:canonical', canonical);
  // An outside change (Undo, a restored draft) replaces the text unless it is what was just typed.
  useEffect(() => {
    if (seen === canonical) return;
    setSeen(canonical);
    setText((now) => {
      const parsed = parseSample(now);
      return parsed.ok && JSON.stringify(parsed.sample) === JSON.stringify(JSON.parse(canonical))
        ? now
        : canonical;
    });
    setProblem(null);
  }, [canonical, seen, setSeen, setText, setProblem]);
  return (
    <FormField label={WB_DESIGN.jsonInput} error={problem ?? undefined}>
      {(control) => (
        <Textarea
          {...control}
          className="font-mono text-xs"
          rows={14}
          spellCheck={false}
          value={text}
          disabled={readOnly}
          onChange={(e) => {
            setText(e.target.value);
            const parsed = parseSample(e.target.value);
            if (!parsed.ok) return setProblem(parsed.problem);
            setProblem(null);
            edit({ op: 'sample-set', sample: parsed.sample }, 'sample-json');
          }}
        />
      )}
    </FormField>
  );
}
