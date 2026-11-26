import type { WalletRole, WalletRoleSource } from '@/passkit/template/wallets/schema.ts';
import { SHORT_NAME, typeLabel, WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { Disclosure } from '../disclosure.tsx';
import { SLOTS, slotStates } from './art-source.ts';
import { roleRows } from './roles-model.ts';
import { FieldsSection } from './section-fields.tsx';
import { ImagesSection } from './section-images.tsx';
import { RequiredSection } from './section-required.tsx';
import { RolesSection } from './section-roles.tsx';
import { TypeSection } from './section-type.tsx';
import { requiredOf, type WalletEnv } from './wallets-env.ts';

const S = WALLETS_COPY.sections;
const fill = (text: string, short: string) => text.replace('{short}', short);

/** The five sections of the focused wallet; one is open at a time and issues can open one. */
export function WalletInspector({ env }: { env: WalletEnv }) {
  const { target, out, block } = env;
  const short = SHORT_NAME[target];
  const roles = (block.roles ?? undefined) as
    | Partial<Record<WalletRole, WalletRoleSource>>
    | undefined;
  const { rows } = roleRows(out.view, target, out.compiled.type, roles, requiredOf(block));
  const art = slotStates(out.view, out.compiled, target);
  const own = art.filter((s) => s.own).length;
  return (
    <nav aria-label="Wallet structure">
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <Disclosure
          section="wallets-type"
          index={0}
          label={fill(S.type, short)}
          value={typeLabel(target, out.compiled.type)}
        >
          <TypeSection env={env} />
        </Disclosure>
        <Disclosure
          section="wallets-roles"
          index={1}
          label={S.roles}
          count={rows.filter((r) => r.group === 'own' && r.resolved).length}
        >
          <RolesSection env={env} />
        </Disclosure>
        <Disclosure
          section="wallets-fields"
          index={2}
          label={fill(S.fields, short)}
          count={out.view.fields.length}
        >
          <FieldsSection env={env} />
        </Disclosure>
        <Disclosure
          section="wallets-images"
          index={3}
          label={fill(S.images, short)}
          value={`${own} of ${SLOTS[target].length}`}
        >
          <ImagesSection env={env} />
        </Disclosure>
        <Disclosure
          section="wallets-required"
          index={4}
          label={S.required}
          count={requiredOf(block).length}
        >
          <RequiredSection env={env} />
        </Disclosure>
      </ul>
    </nav>
  );
}
