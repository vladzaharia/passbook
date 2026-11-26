import { X } from 'lucide-react';
import { capabilityLabel, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { Badge, Combobox } from '../../../../ui/index.ts';
import { capabilityOptions } from './capability-options.ts';
import { requiredOf, type WalletEnv } from './wallets-env.ts';

const C = WALLETS_COPY.required;

/** What every wallet must carry: a wallet that can't is blocked. */
export function RequiredSection({ env }: { env: WalletEnv }) {
  const { block, out, edit, readOnly } = env;
  const required = requiredOf(block);
  const options = capabilityOptions(out.view, required);
  return (
    <div className="grid gap-3">
      {required.length === 0 ? (
        <p className="text-sm text-fg-muted">{C.none}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Required">
          {required.map((id) => (
            <li key={id} data-row-id={`wr-req-${id}`}>
              <Badge tone="accent" className="gap-1 pr-1">
                {capabilityLabel(id)}
                <button
                  type="button"
                  disabled={readOnly}
                  aria-label={C.remove.replace('{label}', capabilityLabel(id))}
                  className="inline-flex size-5 items-center justify-center rounded-full hover:bg-state-hover-tint pointer-coarse:size-11"
                  onClick={() => edit({ op: 'wallets-required', id, on: false })}
                >
                  <X aria-hidden className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Combobox
        aria-label={C.add}
        placeholder={C.add}
        options={options}
        disabled={readOnly || options.length === 0}
        onValueChange={(id) => edit({ op: 'wallets-required', id, on: true })}
      />
      <p className="text-xs text-fg-muted">{C.help}</p>
    </div>
  );
}
