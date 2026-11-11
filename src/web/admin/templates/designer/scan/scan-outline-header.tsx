import { LockKeyhole, Plus } from 'lucide-react';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { inputProps } from '@/passkit/template/scan-display/scope.ts';
import { parseParts } from '@/passkit/template/scan-display/text.ts';
import { Button, FormField, Input, SwitchRow } from '../../../../ui/index.ts';
import { ScanConditionField } from './scan-condition-fields.tsx';
import { ScanIconField, ScanRoleField } from './scan-fields.tsx';
import { Chips, headerOf, setHeader } from './scan-outline-header-parts.tsx';
import { allIds, nextId } from './scan-outline-ids.ts';
import { applySelection, type Editor, Keys, nudgeKey } from './scan-outline-ui.tsx';
import {
  allowedPaths,
  holderIsName,
  labelText,
  normalPath,
  typedManifest,
  withoutRefs,
} from './scan-outline-utils.ts';
import { safePreviewText } from './scan-preview-policy.ts';
import { ScanExpressionField, ScanTextField } from './scan-text-fields.tsx';
import { useRejection } from './use-rejection.ts';

type Header = ScanDisplayDoc['header'];
type Variant = NonNullable<ScanDisplayDoc['variants']>[number];

export { HeaderFields, Rules };

function HeaderFields({ editor: e, variant }: { editor: Editor; variant?: string }) {
  const header = headerOf(e.display, variant);
  const set = (patch: Partial<Header>, merge?: string) =>
    e.onChange(setHeader(e.display, { ...header, ...patch }, variant), merge);
  const titleAllowed = e.screen === 'ok';
  const props = inputProps(typedManifest(e.doc));
  const holderPaths = [
    'pass.title',
    ...[...allowedPaths(e.doc)].filter((path) => {
      if (path.startsWith('fields.')) return true;
      if (!path.startsWith('inputs.')) return false;
      const schema = props[path.slice('inputs.'.length)];
      return !schema || schema.type === undefined || schema.type === 'string';
    }),
  ];
  return (
    <div className="grid gap-4">
      {!variant ? (
        <>
          <p className="text-sm text-fg-muted">
            The holder line always shows. Choose one text input, pass field or the pass title as its
            source.
          </p>
          <ScanExpressionField
            label="Holder source"
            value={e.display.holder}
            manifest={e.bindings.manifest}
            passJson={e.bindings.passJson}
            mergeKey="scan:header:holder"
            optional
            allowedPaths={holderPaths}
            onChange={(holder, merge) => {
              if (holder !== undefined) {
                const parts = parseParts(holder).parts;
                const part = parts?.length === 1 ? parts[0] : undefined;
                if (!part?.path || part.filter || !holderPaths.includes(normalPath(part.path))) {
                  e.say('Choose one unformatted text input, pass field or pass title.');
                  return;
                }
              }
              e.onChange({ ...e.display, holder }, merge);
            }}
          />
          <SwitchRow
            label="Show member photo"
            help="Replaces the pass tile where a photo is available."
            checked={!!e.display.photo}
            onCheckedChange={(checked) =>
              e.onChange({ ...e.display, photo: checked ? {} : undefined })
            }
          />
          {e.display.photo ? (
            <ScanRoleField
              label="Who sees the photo"
              value={e.display.photo.minRole}
              onChange={(minRole) =>
                e.onChange({ ...e.display, photo: { ...e.display.photo, minRole } })
              }
            />
          ) : null}
          <ScanExpressionField
            label="Default currency"
            value={e.display.currency}
            manifest={e.bindings.manifest}
            passJson={e.bindings.passJson}
            mergeKey="scan:header:currency"
            optional
            onChange={(currency, merge) => e.onChange({ ...e.display, currency }, merge)}
          />
        </>
      ) : null}
      {titleAllowed ? (
        <>
          {variant ? (
            <SwitchRow
              label="Override icon"
              checked={header.icon !== undefined}
              onCheckedChange={(checked) => set({ icon: checked ? null : undefined })}
            />
          ) : null}
          {!variant || header.icon !== undefined ? (
            <ScanIconField
              label="Result icon"
              value={header.icon}
              onChange={(icon) => set({ icon: icon ?? (variant ? null : undefined) })}
            />
          ) : null}
          {variant ? (
            <SwitchRow
              label="Override title"
              checked={header.title !== undefined}
              onCheckedChange={(checked) => set({ title: checked ? null : undefined })}
            />
          ) : null}
          {!variant || header.title !== undefined ? (
            <>
              <ScanTextField
                label="Result title"
                value={header.title}
                manifest={e.bindings.manifest}
                passJson={e.bindings.passJson}
                allowedPaths={
                  holderIsName(e.doc, e.display) ? ['holder.name', 'holder.firstName'] : []
                }
                allowFormats={false}
                optional
                mergeKey={`scan:${variant ?? 'header'}:title`}
                onChange={(title, merge) =>
                  set({ title: title ?? (variant ? null : undefined) }, merge)
                }
              />
              {!holderIsName(e.doc, e.display) ? (
                <p className="text-xs text-fg-muted">
                  Choose a name input or field as the holder source to insert a holder name in the
                  title.
                </p>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <p className="rounded-md border border-dashed border-border p-3 text-sm text-fg-muted">
          <LockKeyhole aria-hidden className="mr-1 inline size-4" />
          System:{' '}
          {e.screen === 'ready'
            ? 'there is no result title or icon on the ready screen.'
            : 'heads-up headlines and icons cannot be changed.'}
        </p>
      )}
      {variant ? (
        <SwitchRow
          label="Override meta line"
          checked={header.subtitle !== undefined}
          onCheckedChange={(checked) => set({ subtitle: checked ? null : undefined })}
        />
      ) : null}
      {!variant || header.subtitle !== undefined ? (
        <ScanTextField
          label="Meta line"
          value={header.subtitle}
          manifest={e.bindings.manifest}
          passJson={e.bindings.passJson}
          optional
          mergeKey={`scan:${variant ?? 'header'}:subtitle`}
          onChange={(subtitle, merge) =>
            set({ subtitle: subtitle ?? (variant ? null : undefined) }, merge)
          }
        />
      ) : null}
      <Chips editor={e} variant={variant} />
    </div>
  );
}

function Rules({ editor: e }: { editor: Editor }) {
  const variants = e.display.variants ?? [];
  const set = (next: Variant[], merge?: string, removed: string[] = []) =>
    e.onChange(withoutRefs({ ...e.display, variants: next }, removed), merge);
  const move = (index: number, delta: -1 | 1) => {
    const variant = variants[index];
    if (variant) applySelection(e, variant.id, delta === -1 ? 'up' : 'down');
  };
  return (
    <div className="grid gap-3">
      <p className="text-sm text-fg-muted">
        The first matching rule chooses the header. Unset slots use the default header.
      </p>
      <ul aria-label="Header rules" className="grid gap-2">
        {variants.map((variant, index) => {
          const open =
            e.selected === variant.id ||
            (variant.header.chips ?? []).some((chip) => chip.id === e.selected);
          const update = (patch: Partial<Variant>, merge?: string) =>
            set(
              variants.map((item) => (item.id === variant.id ? { ...item, ...patch } : item)),
              merge,
            );
          return (
            <li className="dz-row" data-open={open || undefined} key={variant.id}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="dz-pick"
                  data-target={`scan-display:${variant.id}`}
                  aria-expanded={open}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onClick={() => e.onSelect(open ? 'rules' : variant.id)}
                  onKeyDown={(event) => nudgeKey(event, (delta) => move(index, delta))}
                >
                  {labelText(variant.name, `Rule ${index + 1}`)}
                </button>
                <Keys
                  name={`rule ${labelText(variant.name, String(index + 1))}`}
                  index={index}
                  length={variants.length}
                  onMove={(delta) => move(index, delta)}
                  onDuplicate={() => applySelection(e, variant.id, 'duplicate')}
                  disabledDuplicate={
                    variants.length >= 8 ? 'A display holds eight rules' : undefined
                  }
                  onRemove={() => applySelection(e, variant.id, 'remove')}
                />
              </div>
              {open ? (
                <div className="dz-editor grid gap-4">
                  <RuleName
                    name={variant.name}
                    onChange={(name) => update({ name }, `scan:${variant.id}:name`)}
                  />
                  <ScanConditionField
                    label="When"
                    required
                    value={variant.when}
                    manifest={e.bindings.manifest}
                    passJson={e.bindings.passJson}
                    mergeKey={`scan:${variant.id}:when`}
                    onChange={(when, merge) => {
                      if (when) update({ when }, merge);
                    }}
                  />
                  <HeaderFields editor={e} variant={variant.id} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Button
        size="sm"
        variant="outline"
        iconStart={<Plus aria-hidden />}
        disabled={variants.length >= 8}
        onClick={() => {
          const variant: Variant = {
            id: nextId(allIds(e.display), 'v_'),
            name: `Rule ${variants.length + 1}`,
            when: { path: 'pass.status', eq: 'active' },
            header: {},
          };
          set([...variants, variant]);
          e.onSelect(variant.id);
          e.say('Rule added.');
        }}
      >
        Add rule
      </Button>
    </div>
  );
}

function RuleName({ name, onChange }: { name: string; onChange: (name: string) => void }) {
  const rejection = useRejection(true);
  const unsafe = !safePreviewText(name);
  return (
    <FormField
      label="Rule name"
      error={rejection.error}
      help={unsafe ? 'This name cannot be displayed safely. Enter a replacement.' : undefined}
    >
      {(control) => (
        <Input
          {...control}
          maxLength={24}
          value={unsafe ? '' : name}
          onBlur={rejection.clear}
          onChange={(event) => {
            if (rejection.accept(event.target.value)) onChange(event.target.value);
          }}
        />
      )}
    </FormField>
  );
}
