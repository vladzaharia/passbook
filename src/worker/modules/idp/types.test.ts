import { describe, expectTypeOf, it } from 'vitest';
import type {
  IdpCode as BindingCode,
  IdpRpc as BindingRpc,
} from '../../../../workers/passbook-id-connector/src/types.ts';
import type { IdpCode, IdpRpc } from './types.ts';

describe('binding contract', () => {
  it('PassBook types equal the binding types', () => {
    expectTypeOf<IdpRpc>().toEqualTypeOf<BindingRpc>();
    expectTypeOf<IdpCode>().toEqualTypeOf<BindingCode>();
  });
});
