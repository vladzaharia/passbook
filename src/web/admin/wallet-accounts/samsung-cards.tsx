import { type FormEvent, useState } from 'react';
import { SAMSUNG_CARD_TYPES, type WalletCredential } from '@/shared/contracts/wallet-providers.ts';
import { Button, FormField, Input, StatusPill, toast } from '@/web/ui/index.ts';
import { safeError } from './copy.ts';
import { useWalletActions } from './queries.ts';

const CARD_ID = /^[A-Za-z0-9_-]{1,32}$/;

function CardRow({ credential, type }: { credential: WalletCredential; type: string }) {
  const actions = useWalletActions();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const set = credential.cardTypes.includes(type);
  const invalid = value !== '' && !CARD_ID.test(value);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!CARD_ID.test(value)) return;
    setBusy(true);
    try {
      await actions.setCard(credential, type, value);
      setValue('');
      toast.success(`Card set for ${type}`);
    } catch (cause) {
      toast.error(safeError(cause), 'Could not set the card');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-end justify-between gap-3">
      {set ? (
        <>
          <span className="text-sm font-medium capitalize text-fg-strong">{type}</span>
          <StatusPill status="set" tone="success">
            Card set
          </StatusPill>
        </>
      ) : (
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
          <FormField
            label={`Card ID for ${type}`}
            error={invalid ? 'Use 1–32 letters, numbers, underscores or hyphens.' : undefined}
          >
            {(props) => (
              <Input
                {...props}
                autoComplete="off"
                value={value}
                onChange={(event) => setValue(event.target.value.trim())}
              />
            )}
          </FormField>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            loading={busy}
            disabled={!CARD_ID.test(value)}
          >
            Set
          </Button>
        </form>
      )}
    </li>
  );
}

/** One card per pass type on the platform partner. A card, once named, does not change. */
export function SamsungCards({ credential }: { credential: WalletCredential }) {
  return (
    <ul
      aria-label="Samsung cards"
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      {SAMSUNG_CARD_TYPES.map((type) => (
        <CardRow key={type} credential={credential} type={type} />
      ))}
    </ul>
  );
}
