import { WorkerEntrypoint } from 'cloudflare:workers';
import { createApi } from './api.ts';
import type { BindingEnv, IdpRpc } from './types.ts';

const api = (env: BindingEnv) =>
  createApi(env, { fetch: (input, init) => fetch(input, init), now: () => Date.now() });

/** Exactly the RPC methods of design 5.3: every public method here is callable by the main Worker. There is no thaw. */
export class PolarisBinding extends WorkerEntrypoint<BindingEnv> implements IdpRpc {
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
  groups() {
    return api(this.env).groups();
  }
  createGroup(...a: Parameters<IdpRpc['createGroup']>) {
    return api(this.env).createGroup(...a);
  }
  ensureRoleGroup(...a: Parameters<IdpRpc['ensureRoleGroup']>) {
    return api(this.env).ensureRoleGroup(...a);
  }
  updateGroup(...a: Parameters<IdpRpc['updateGroup']>) {
    return api(this.env).updateGroup(...a);
  }
  deleteGroup(...a: Parameters<IdpRpc['deleteGroup']>) {
    return api(this.env).deleteGroup(...a);
  }
  claims(...a: Parameters<IdpRpc['claims']>) {
    return api(this.env).claims(...a);
  }
  setClaims(...a: Parameters<IdpRpc['setClaims']>) {
    return api(this.env).setClaims(...a);
  }
  findByVerifiedEmail(...a: Parameters<IdpRpc['findByVerifiedEmail']>) {
    return api(this.env).findByVerifiedEmail(...a);
  }
  lookup(...a: Parameters<IdpRpc['lookup']>) {
    return api(this.env).lookup(...a);
  }
  apply(...a: Parameters<IdpRpc['apply']>) {
    return api(this.env).apply(...a);
  }
  setDisabled(...a: Parameters<IdpRpc['setDisabled']>) {
    return api(this.env).setDisabled(...a);
  }
  snapshot(...a: Parameters<IdpRpc['snapshot']>) {
    return api(this.env).snapshot(...a);
  }
  freeze(...a: Parameters<IdpRpc['freeze']>) {
    return api(this.env).freeze(...a);
  }
  calls(...a: Parameters<IdpRpc['calls']>) {
    return api(this.env).calls(...a);
  }
}

export default {
  fetch: () => new Response('Not found', { status: 404 }),
};
