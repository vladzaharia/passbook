import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { errorMessage, isApiError } from '../../lib/errors.ts';
import { Button, Card, CardBody, CardHeader, Textarea, toast } from '../../ui/index.ts';
import { useTemplateActions } from './api.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** JSON editor for an uploaded template's manifest; the server validates on save. */
export function ManifestEditor({ template }: { template: Template }) {
  const actions = useTemplateActions(template.id);
  const [text, setText] = useState(() => pretty(template.manifest));
  const [problems, setProblems] = useState<string[]>([]);
  const dirty = text !== pretty(template.manifest);

  async function save() {
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch (cause) {
      return setProblems([
        `Invalid JSON: ${cause instanceof Error ? cause.message : 'parse error'}`,
      ]);
    }
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      return setProblems(['The manifest must be a JSON object.']);
    }
    setProblems([]);
    try {
      const next = await actions.replaceManifest.mutateAsync(manifest as Record<string, unknown>);
      setText(pretty(next.manifest));
      toast.success('Manifest saved');
    } catch (error) {
      const fields = isApiError(error) ? Object.entries(error.fields) : [];
      setProblems(
        fields.length > 0
          ? fields.map(([path, message]) => (path ? `${path}: ${message}` : message))
          : [errorMessage(error)],
      );
    }
  }

  return (
    <Card>
      <CardHeader
        title="Manifest"
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty}
              onClick={() => {
                setText(pretty(template.manifest));
                setProblems([]);
              }}
            >
              Discard
            </Button>
            <Button
              size="sm"
              disabled={!dirty}
              loading={actions.replaceManifest.isPending}
              onClick={() => void save()}
            >
              Save
            </Button>
          </>
        }
      />
      <CardBody className="grid gap-3">
        <Textarea
          aria-label="Manifest JSON"
          aria-invalid={problems.length > 0}
          className="font-mono text-xs"
          rows={24}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {problems.length > 0 ? (
          <ul role="alert" className="grid gap-1 text-sm text-danger">
            {problems.map((p) => (
              <li key={p} className="font-mono text-xs">
                {p}
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
