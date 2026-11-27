import { useDesigner } from '../../admin/templates/designer/context.tsx';
import { sampleText } from './sample.ts';
import { SampleJsonField } from './sample-json-field.tsx';

/** The same sample as JSON, each valid object a draft change like any other. */
export default function SampleJson() {
  const { doc, edit, readOnly } = useDesigner();
  return (
    <SampleJsonField
      canonical={sampleText(doc)}
      disabled={readOnly}
      onSample={(sample) => edit({ op: 'sample-set', sample }, 'sample-json')}
    />
  );
}
