import { useState } from 'react';
import { checkExpr } from '@/passkit/template/expr.ts';
import { FILTERS } from '@/passkit/template/scan-display/format.ts';
import { parseParts, splitPath } from '@/passkit/template/scan-display/text.ts';
import { Button, Combobox, FormField, Input, Select } from '../../../../ui/index.ts';
import { editorKey, useEditorKeys } from './scan-field-keys.ts';
import { type Option, pickerPaths, safeScanExpression, words } from './scan-fields.tsx';
import { safePreviewText } from './scan-preview-policy.ts';
import { useRejection } from './use-rejection.ts';

type StringFieldProps = {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string, merge?: string) => void;
  mergeKey: string;
  expressionOnly?: boolean;
  allowFormats?: boolean;
};

/** Literal runs are normal inputs; bindings are separate removable, formattable tokens. */
export function StringField({
  label,
  value,
  options,
  onChange,
  mergeKey,
  expressionOnly = false,
  allowFormats = true,
}: StringFieldProps) {
  const enabled = pickerPaths(options);
  const scope = [...enabled].join('\n');
  const safeCurrent = safeScanExpression(value, options);
  const [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState(safeCurrent ? value : '');
  const [seen, setSeen] = useState(value);
  const [seenScope, setSeenScope] = useState(scope);
  const rejection = useRejection();
  const [cursor, setCursor] = useState<{ part: number; start: number; end: number } | null>(null);
  if (seen !== value || seenScope !== scope) {
    if (seenScope !== scope) setAdvanced(false);
    setSeen(value);
    setSeenScope(scope);
    setDraft(safeCurrent ? value : '');
  }
  const parsed = parseParts(value);
  const pieces = parsed.parts ? value.split(/(\{\{[^{}]*\}\})/g) : [value];
  const { keys: pieceKeys, items: keyedPieces, remember: rememberPieces } = useEditorKeys(pieces);
  const atLimit = value.split('{{').length - 1 >= 8;
  const validDraft =
    safeScanExpression(draft, options) &&
    (!expressionOnly || (draft.length <= 256 && checkExpr(draft) === null)) &&
    (allowFormats || (parseParts(draft).parts?.every((part) => !part.filter) ?? false));
  const replace = (index: number, next: string, merge?: string) => {
    const updated = pieces.map((piece, i) => (i === index ? next : piece)).join('');
    if (updated.length > (expressionOnly ? 256 : 512) && updated.length >= value.length) return;
    if (!parseParts(updated).parts) return;
    let nextKeys = pieceKeys;
    if (index % 2 === 0 && next.includes('{{')) {
      // Inserting a binding splits a literal into the old run, a token and a new run.
      nextKeys = [
        ...pieceKeys.slice(0, index + 1),
        editorKey(),
        editorKey(),
        ...pieceKeys.slice(index + 1),
      ];
    } else if (index % 2 === 1 && next === '') {
      // Removing a binding joins its surrounding literals; retain the left run's identity.
      nextKeys = [...pieceKeys.slice(0, index), ...pieceKeys.slice(index + 2)];
    }
    rememberPieces(updated.split(/(\{\{[^{}]*\}\})/g), nextKeys);
    onChange(updated, merge);
  };
  const insert = (path: string) => {
    if (!enabled.has(path) || atLimit) return;
    const at = cursor && cursor.part % 2 === 0 && cursor.part < pieces.length ? cursor : null;
    const index = at?.part ?? pieces.length - 1;
    const text = pieces[index] ?? '';
    const start = Math.min(at?.start ?? text.length, text.length);
    const end = Math.min(at?.end ?? text.length, text.length);
    replace(index, `${text.slice(0, start)}{{${path}}}${text.slice(end)}`);
    setCursor(null);
  };
  return (
    <div className="grid gap-2">
      {parsed.parts ? (
        <div className="grid gap-2">
          {keyedPieces.map(({ value: piece, key }, index) => {
            if (index % 2 === 0) {
              if (!safePreviewText(piece))
                return (
                  <div key={key} className="grid gap-2 text-sm text-fg-muted">
                    <span>{label}: Sensitive text hidden and preserved.</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="justify-self-start"
                      onClick={() => replace(index, '')}
                    >
                      Replace {label} text
                    </Button>
                  </div>
                );
              const input = (control: {
                id?: string;
                'aria-describedby'?: string;
                'aria-invalid'?: true;
                'aria-required'?: true;
              }) => (
                <Input
                  {...control}
                  aria-label={
                    index === 0 ? undefined : `${label} text ${Math.floor(index / 2) + 1}`
                  }
                  value={piece}
                  onSelect={(event) =>
                    setCursor({
                      part: index,
                      start: event.currentTarget.selectionStart ?? piece.length,
                      end: event.currentTarget.selectionEnd ?? piece.length,
                    })
                  }
                  onBlur={rejection.clear}
                  onChange={(event) => {
                    if (rejection.accept(event.target.value, index))
                      replace(index, event.target.value, mergeKey);
                  }}
                />
              );
              return index === 0 ? (
                <FormField key={key} label={label} error={rejection.errorAt(0)}>
                  {input}
                </FormField>
              ) : (
                <div key={key} className="grid gap-1">
                  {input({ 'aria-invalid': rejection.errorAt(index) ? true : undefined })}
                  {rejection.errorAt(index) ? (
                    <p className="text-xs text-danger">{rejection.errorAt(index)}</p>
                  ) : null}
                </div>
              );
            }
            const part = parseParts(piece).parts?.[0];
            const split = part?.path ? splitPath(part.path) : null;
            const known = part?.path
              ? enabled.has(part.path) ||
                (split?.root === 'inputs' &&
                  split.rest.length === 1 &&
                  enabled.has(`inputs.${split.rest[0]}`))
              : false;
            const tokenLabel = known && part?.path ? words(part.path) : 'Unavailable field';
            return (
              <div
                key={key}
                className="flex flex-wrap items-center gap-2 rounded-md bg-accent-subtle p-2 text-sm"
              >
                <button
                  type="button"
                  className="font-medium text-accent-fg focus-visible:outline-2 focus-visible:outline-focus"
                  aria-label={`Field ${tokenLabel}`}
                  title={
                    known && !expressionOnly && allowFormats
                      ? 'Press Backspace to remove; Enter opens formatting.'
                      : 'Press Backspace to remove.'
                  }
                  onClick={(event) => {
                    event.currentTarget.parentElement
                      ?.querySelector<HTMLButtonElement>('button[role="combobox"]')
                      ?.click();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Backspace' || event.key === 'Delete') {
                      event.preventDefault();
                      replace(index, '');
                    }
                  }}
                >
                  {tokenLabel}
                </button>
                {known && !expressionOnly && allowFormats ? (
                  <Select
                    className="w-auto min-w-32"
                    aria-label={`Format ${tokenLabel}`}
                    value={part?.filter ?? '__none'}
                    options={[
                      { value: '__none', label: 'No format' },
                      ...FILTERS.map((filter) => ({ value: filter, label: words(filter) })),
                    ]}
                    onValueChange={(filter) =>
                      replace(index, `{{${part?.path}${filter === '__none' ? '' : `|${filter}`}}}`)
                    }
                  />
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${tokenLabel}`}
                  onClick={() => replace(index, '')}
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">
          This expression needs attention. Open advanced editing to repair it; it is preserved until
          changed.
        </p>
      )}
      <Combobox
        aria-label={`Insert field into ${label}`}
        options={options}
        disabled={!parsed.parts || atLimit}
        placeholder="Insert field"
        searchPlaceholder="Find a field"
        onValueChange={insert}
      />
      {atLimit ? (
        <p className="text-xs text-fg-muted">A text can contain at most eight fields.</p>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        className="justify-self-start"
        aria-expanded={advanced}
        onClick={() => {
          setDraft(safeCurrent ? value : '');
          setAdvanced(!advanced);
        }}
      >
        {advanced ? 'Hide advanced expression' : 'Advanced expression'}
      </Button>
      {advanced ? (
        <div className="grid gap-2">
          <FormField
            label={`${label} expression`}
            help="Only fields available to this audience and scanner-safe formats can be used."
            error={
              draft !== value && !validDraft
                ? 'Use valid, available fields and scanner-safe formats.'
                : undefined
            }
          >
            {(control) => (
              <Input
                {...control}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            )}
          </FormField>
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            disabled={draft === value || !validDraft}
            onClick={() => onChange(draft, mergeKey)}
          >
            Apply expression
          </Button>
        </div>
      ) : null}
    </div>
  );
}
