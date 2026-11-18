import { Info, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { formatShortDate } from '../../lib/format.ts';
import { RadioGroup } from '../../ui/radio-group.tsx';
import { ScanTextField } from '../input/wedge-field.tsx';
import type { AssignState } from '../machine/assign-state.ts';
import { ApprovalSheet } from '../result/approval-sheet.tsx';
import { fill } from '../ui/copy.ts';
import { Identity } from './assign-steps.tsx';
import { TAG_EXTRA_COPY } from './copy.ts';
import { TagChip } from './tag-chip.tsx';

/** The one line under the choice, in the order UX 3.2 gives: moves, another person's, basic. */
export function infoLine(a: AssignState): { tone: 'info' | 'warn' | 'muted'; text: string } | null {
  const w = a.preview?.warnings ?? [];
  const name = a.preview?.card.holderName ?? a.preview?.card.title ?? '';
  const bound = a.inspected?.bound;
  if (w.includes('held_by_other'))
    return {
      tone: 'warn',
      text: fill(SCAN_TAG_COPY.confirm.moveOther, {
        holder: bound?.holderName ?? 'someone',
        pass: bound?.passTitle ?? 'pass',
        name,
      }),
    };
  if (w.includes('lost'))
    return {
      tone: 'warn',
      text: fill(TAG_EXTRA_COPY.lostWarn, {
        date: a.preview?.lostAt ? formatShortDate(a.preview.lostAt) : '',
      }),
    };
  if (w.includes('replaces_user_tag'))
    return { tone: 'info', text: fill(SCAN_TAG_COPY.confirm.moveOwn[1], { name }) };
  if (w.includes('replaces_pass_tag'))
    return {
      tone: 'info',
      text: fill(SCAN_TAG_COPY.confirm.moveOwn[0], {
        pass: bound?.passTitle ?? a.preview?.card.title ?? '',
      }),
    };
  if (w.includes('basic_too_low')) return { tone: 'warn', text: TAG_EXTRA_COPY.basicLow };
  if (a.preview?.assurance === 'basic') return { tone: 'muted', text: SCAN_TAG_COPY.confirm.basic };
  return null;
}

export function ConfirmBody({
  a,
  manager,
  managers,
  code,
  on,
}: {
  a: AssignState;
  manager: boolean;
  managers: { id: string; name: string }[];
  code: boolean;
  on: {
    scope(scope: 'pass' | 'user'): void;
    label(label: string): void;
    approve(staffId: string | undefined, pin: string): void;
    closePin(): void;
  };
}) {
  const p = a.preview;
  const [form, setForm] = useState<string | null>(null);
  if (!p) return null;
  const name = p.card.holderName ?? p.card.title;
  const info = infoLine(a);
  const choose = p.ownerAccount && !a.request;
  return (
    <>
      <Identity name={name} meta={p.card.templateName} heading />
      <div className="scan-assign-link">
        <TagChip hint={p.hint} assurance={p.assurance} />
      </div>
      {choose ? (
        <RadioGroup
          legend={SCAN_TAG_COPY.worksWith.label}
          value={a.scope}
          onValueChange={(v) => on.scope(v as 'pass' | 'user')}
          options={[
            {
              value: 'user',
              label: fill(SCAN_TAG_COPY.worksWith.person, { name }),
              hint: a.scope === 'user' ? fill(SCAN_TAG_COPY.worksWith.future, { name }) : undefined,
            },
            { value: 'pass', label: SCAN_TAG_COPY.worksWith.pass, hint: p.card.title },
          ]}
        />
      ) : (
        <p className="scan-assign-opens">
          <span className="scan-assign-opens-label">{SCAN_TAG_COPY.worksWith.label}</span>
          {p.ownerAccount ? SCAN_TAG_COPY.worksWith.pass : SCAN_TAG_COPY.worksWith.noAccount}
          {!p.ownerAccount ? (
            <span className="scan-identity-meta">
              {fill(SCAN_TAG_COPY.worksWith.noAccountSub, { name })}
            </span>
          ) : null}
        </p>
      )}
      <label className="scan-assign-field">
        <span>{SCAN_TAG_COPY.confirm.name}</span>
        <ScanTextField
          value={a.label}
          maxLength={24}
          placeholder={SCAN_TAG_COPY.confirm.namePlaceholder}
          autoComplete="off"
          onValueRestore={on.label}
          onChange={(e) => {
            setForm(null);
            on.label(e.target.value);
          }}
        />
      </label>
      <div className="scan-assign-forms" role="group" aria-label="Kind">
        {SCAN_TAG_COPY.confirm.forms.map((f) => (
          <button
            key={f}
            type="button"
            className="scan-assign-form"
            aria-pressed={form === f}
            onClick={() => {
              setForm(form === f ? null : f);
              on.label(form === f ? '' : f);
            }}
          >
            {f}
          </button>
        ))}
      </div>
      {info ? (
        <p className="scan-assign-info" data-tone={info.tone} data-testid="scan-assign-info">
          {info.tone === 'warn' ? (
            <TriangleAlert aria-hidden size={16} />
          ) : (
            <Info aria-hidden size={16} />
          )}
          {info.text}
        </p>
      ) : null}
      {a.pin?.open && !manager ? (
        <ApprovalSheet
          managers={managers}
          code={code}
          action={fill('Assigning a tag to {name}', { name })}
          note={a.pin.note}
          onApprove={on.approve}
          onCancel={on.closePin}
        />
      ) : null}
    </>
  );
}
