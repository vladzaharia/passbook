import { WorkerEntrypoint } from 'cloudflare:workers';
import { createApi } from './api.ts';
import type { IdpRpc, ProvisionerEnv } from './types.ts';

const api = (env: ProvisionerEnv) =>
  createApi(env, { fetch: (input, init) => fetch(input, init), now: () => Date.now() });

/** Exactly the RPC methods of design 3.2: every public method here is callable by the main Worker. */
export class IdpProvisioner extends WorkerEntrypoint<ProvisionerEnv> implements IdpRpc {
  health() {
    return api(this.env).health();
  }
  createSignup(...a: Parameters<IdpRpc['createSignup']>) {
    return api(this.env).createSignup(...a);
  }
  deleteSignup(...a: Parameters<IdpRpc['deleteSignup']>) {
    return api(this.env).deleteSignup(...a);
  }
  proveSignup(...a: Parameters<IdpRpc['proveSignup']>) {
    return api(this.env).proveSignup(...a);
  }
  addDeveloper(...a: Parameters<IdpRpc['addDeveloper']>) {
    return api(this.env).addDeveloper(...a);
  }
  removeDeveloper(...a: Parameters<IdpRpc['removeDeveloper']>) {
    return api(this.env).removeDeveloper(...a);
  }
  calls(...a: Parameters<IdpRpc['calls']>) {
    return api(this.env).calls(...a);
  }
}

export default {
  fetch: () => new Response('Not found', { status: 404 }),
};
