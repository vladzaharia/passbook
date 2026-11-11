import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { errorMessage, isApiError } from '../../lib/errors.ts';
import {
  Card,
  CardBody,
  CardHeader,
  SaveBar,
  Textarea,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import { useTemplateActions } from './api.ts';
import { versionName, versionNumber } from './versions.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** JSON editor for an uploaded template's manifest; the server validates on save. */
export function ManifestEditor({ template }: { template: Template }) {
  const actions = useTemplateActions(template.id);
  // The server returns the legacy manifest, not the saved version's, so the editor keeps what
  // was submitted as its baseline until the active version changes (the parent remounts it).
  const [saved, setSaved] = useState(() => pretty(template.manifest));
  const [text, setText] = useState(saved);
  const [problems, setProblems] = useState<string[]>([]);
  const dirty = text !== saved;
  const guard = useUnsavedChangesGuard(dirty);

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
      setSaved(text);
      const made = next.versions.reduce<(typeof next.versions)[number] | undefined>(
        (latest, v) => (!v.active && (!latest || v.createdAt > latest.createdAt) ? v : latest),
        undefined,
      );
      const number = versionNumber(next, made?.version ?? null);
      toast.success(`${versionName(number)} saved, inactive`);
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
      <CardHeader title="Manifest" />
      <CardBody className="grid gap-3">
        <p className="text-sm text-fg-muted">Saving creates an inactive version.</p>
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
      <SaveBar
        dirty={dirty}
        saving={actions.replaceManifest.isPending}
        onSave={() => void save()}
        onDiscard={() => {
          setText(saved);
          setProblems([]);
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );
}
