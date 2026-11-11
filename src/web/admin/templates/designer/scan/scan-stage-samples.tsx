import { useEffect, useState } from 'react';
import { inputProps, inputVisibleTo } from '@/passkit/template/scan-display/scope.ts';
import type { ScanDisplayScope } from '@/passkit/template/scan-display/text.ts';
import type { Json, ScanRole } from '@/passkit/types.ts';
import { MODE_HEADER, type Mode } from '@/shared/contracts/common.ts';
import { ScanDisplayPreviewSchema } from '@/shared/contracts/scan-display-preview.ts';
import { api } from '@/web/lib/api.ts';
import type { DesignDoc } from '../model.ts';
import {
  previewManifest,
  previewSecrets,
  privatePreviewKey,
  safePreviewText,
} from './scan-preview-policy.ts';

type RealScope = { key: string; scope: Record<string, Json> };

export function useRealPreview(
  orgId: string | null,
  templateId: string,
  mode: Mode,
  role: ScanRole,
  passId: string | null,
  request: number,
) {
  const key = JSON.stringify([orgId, templateId, mode, role, passId, request]);
  const [result, setResult] = useState<RealScope | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!passId || !orgId || !templateId) {
      setStatus('idle');
      setError(null);
      return;
    }
    const controller = new AbortController();
    setResult(null);
    setError(null);
    setStatus('loading');
    void api
      .get('/api/v1/scan-display/preview', ScanDisplayPreviewSchema, {
        query: { orgId, mode, templateId, passId, role },
        headers: { [MODE_HEADER]: mode },
        signal: controller.signal,
      })
      .then(({ scope }) => {
        if (!controller.signal.aborted) {
          setResult({ key, scope });
          setStatus('idle');
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setResult(null);
          setError(cause);
          setStatus('error');
        }
      });
    return () => controller.abort();
  }, [orgId, templateId, mode, role, passId, key]);
  // The key check is synchronous: a render for another role/pass/org/mode can never paint an old response.
  return {
    scope: result?.key === key && passId && orgId ? result.scope : null,
    status,
    error: status === 'error' ? error : null,
    discard: () => setResult(null),
  };
}

export function SampleInputs({
  doc,
  role,
  overrides,
  onChange,
  scope,
}: {
  doc: DesignDoc;
  role: ScanRole;
  overrides: Record<string, Json>;
  onChange: (next: Record<string, Json>) => void;
  scope: ScanDisplayScope | null;
}) {
  if (!scope)
    return (
      <p className="sp-help">
        The sample cannot be generated until invalid template settings are corrected.
      </p>
    );
  const manifest = previewManifest(doc);
  const secrets = previewSecrets(manifest);
  const inputs = (
    scope.inputs && typeof scope.inputs === 'object' && !Array.isArray(scope.inputs)
      ? scope.inputs
      : {}
  ) as Record<string, Json>;
  const entries = Object.entries(inputProps(manifest)).filter(
    ([name, schema]) =>
      safePreviewText(name) &&
      !privatePreviewKey(name) &&
      inputVisibleTo(name, schema, role, secrets) &&
      ['string', 'number', 'integer', 'boolean'].includes(String(schema.type)),
  );
  if (!entries.length)
    return <p className="sp-help">No sample inputs are available for this role.</p>;
  return (
    <div className="sp-inputs">
      {entries.map(([name, schema]) => {
        const label =
          typeof schema['x-label'] === 'string' && safePreviewText(schema['x-label'])
            ? schema['x-label']
            : name;
        const value = inputs[name];
        const set = (v: Json) => onChange({ ...overrides, [name]: v });
        if (Array.isArray(schema.enum)) {
          const options = schema.enum.filter(
            (item): item is string | number | boolean =>
              (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') &&
              safePreviewText(String(item)),
          );
          const occurrences = new Map<string, number>();
          return options.length ? (
            <label key={name}>
              {label}
              <select
                value={String(
                  typeof value === 'string' ||
                    typeof value === 'number' ||
                    typeof value === 'boolean'
                    ? options.indexOf(value)
                    : -1,
                )}
                onChange={(e) => {
                  const choice = options[Number(e.target.value)];
                  if (choice !== undefined) set(choice);
                }}
              >
                <option value="-1">Choose</option>
                {options.map((item, index) => {
                  const identity = `${typeof item}:${String(item)}`;
                  const occurrence = occurrences.get(identity) ?? 0;
                  occurrences.set(identity, occurrence + 1);
                  return (
                    <option key={`${identity}:${occurrence}`} value={index}>
                      {String(item)}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : null;
        }
        if (schema.type === 'boolean')
          return (
            <label key={name} className="sp-check">
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => set(e.target.checked)}
              />
              {label}
            </label>
          );
        return (
          <label key={name}>
            {label}
            <input
              type={schema.type === 'string' ? 'text' : 'number'}
              value={typeof value === 'string' || typeof value === 'number' ? value : ''}
              onChange={(e) => {
                const text = e.target.value;
                if (schema.type === 'string') {
                  if (safePreviewText(text)) set(text);
                } else if (text === '') set('');
                else if (Number.isFinite(Number(text))) set(Number(text));
              }}
            />
          </label>
        );
      })}
    </div>
  );
}
