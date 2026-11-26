import { ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { SCOPE_LABEL } from '../../../shared/copy/api-key-scopes.ts';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import {
  FULL_SANDBOX,
  KEY_EXPIRY_DAYS,
  presetsWithin,
  SANDBOX_CEILING,
} from '../../../shared/developers-keys.ts';
import { Sheet } from '../../developers/ui/sheet.tsx';
import { StepUp } from '../../developers/ui/step-up.tsx';
import { type KeyApi, KeyError, type MintedKey } from './api.ts';

const DAY = 86_400_000;
const C = KEYS_COPY.sheet;
const PRESETS = presetsWithin(SANDBOX_CEILING);
type Choice = (typeof PRESETS)[number]['id'] | typeof FULL_SANDBOX.id | 'pick';

const scopesOf = (choice: Choice, picked: readonly string[]): string[] =>
  choice === 'pick'
    ? [...picked]
    : choice === 'full'
      ? [...SANDBOX_CEILING]
      : [...(PRESETS.find((p) => p.id === choice)?.scopes ?? [])];

/** New key: a name, an access preset (or picked scopes under the sandbox ceiling) and an expiry. */
export function NewKeySheet({
  orgId,
  api,
  onMade,
  onClose,
  now = Date.now,
}: {
  orgId: string;
  api: KeyApi;
  onMade: (key: MintedKey) => void;
  onClose: () => void;
  now?: () => number;
}) {
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<Choice>('issue');
  const [picked, setPicked] = useState<string[]>([]);
  const [days, setDays] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stepUp, setStepUp] = useState<string | null>(null);
  const [failed, setFailed] = useState<string>();
  const id = useId();
  const scopes = scopesOf(choice, picked);

  const submit = async () => {
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = C.needName;
    if (scopes.length === 0) found.scopes = C.needScopes;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setFailed(undefined);
    try {
      onMade(await api.mint({ orgId, name: name.trim(), scopes, expiresAt: now() + days * DAY }));
    } catch (e) {
      if (e instanceof KeyError && e.stepUp) setStepUp(e.signInUrl ?? '');
      else if (e instanceof KeyError && Object.keys(e.fields).length > 0) setErrors(e.fields);
      else setFailed(e instanceof Error ? e.message : KEYS_COPY.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={C.title}
      onClose={onClose}
      footer={
        <>
          <span className="xs muted ks-passkey">
            <ShieldCheck aria-hidden="true" />
            {C.passkey}
          </span>
          <button
            type="submit"
            form={`${id}-form`}
            className="btn"
            disabled={busy}
            aria-busy={busy}
          >
            {C.create}
          </button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        className="stack g4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="stack g2">
          <label htmlFor={`${id}-name`}>{C.name}</label>
          <input
            id={`${id}-name`}
            // biome-ignore lint/a11y/noAutofocus: the sheet's first field
            autoFocus
            autoComplete="off"
            maxLength={120}
            placeholder={C.namePlaceholder}
            value={name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${id}-name-e` : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {errors.name ? (
            <p id={`${id}-name-e`} className="xs ks-err">
              {errors.name}
            </p>
          ) : null}
        </div>
        <fieldset className="stack g2 ks-set">
          <legend>{C.access}</legend>
          {[...PRESETS, FULL_SANDBOX].map((p) => (
            <label key={p.id} className="ks-tile" data-on={choice === p.id || undefined}>
              <input
                type="radio"
                name={`${id}-access`}
                checked={choice === p.id}
                onChange={() => setChoice(p.id)}
              />
              <span className="stack g1">
                <span className="strong sm">{p.label}</span>
                <span className="wrap-row g1">
                  {scopesOf(p.id, []).map((s) => (
                    <code key={s} className="chip mono">
                      {s}
                    </code>
                  ))}
                </span>
              </span>
            </label>
          ))}
          <label className="ks-tile" data-on={choice === 'pick' || undefined}>
            <input
              type="radio"
              name={`${id}-access`}
              checked={choice === 'pick'}
              onChange={() => setChoice('pick')}
            />
            <span className="strong sm">{C.pick}</span>
          </label>
          {choice === 'pick' ? (
            <ul className="ks-scopes">
              {SANDBOX_CEILING.map((s) => (
                <li key={s}>
                  <label className="ks-scope">
                    <input
                      type="checkbox"
                      checked={picked.includes(s)}
                      onChange={(e) =>
                        setPicked(e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))
                      }
                    />
                    <span className="sm">{SCOPE_LABEL[s] ?? s}</span>
                    <code className="xs muted">{s}</code>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          {errors.scopes ? <p className="xs ks-err">{errors.scopes}</p> : null}
        </fieldset>
        <fieldset className="stack g2 ks-set">
          <legend>{C.expires}</legend>
          <div className="ks-days">
            {KEY_EXPIRY_DAYS.map((n) => (
              <label key={n} data-on={days === n || undefined}>
                <input
                  type="radio"
                  name={`${id}-days`}
                  checked={days === n}
                  onChange={() => setDays(n)}
                />
                {C.days(n)}
              </label>
            ))}
          </div>
          {errors.expiresAt ? <p className="xs ks-err">{errors.expiresAt}</p> : null}
        </fieldset>
        {stepUp !== null ? <StepUp signInUrl={stepUp} next="/developers/keys#new" /> : null}
        {failed ? (
          <p className="sm ks-err" role="alert">
            {failed}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
