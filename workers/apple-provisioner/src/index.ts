import { WorkerEntrypoint } from 'cloudflare:workers';
import { createApi } from './api.ts';
import type { AppleRpc, ProvisionerEnv } from './types.ts';

const api = (env: ProvisionerEnv) =>
  createApi(env, { fetch: (input, init) => fetch(input, init), now: () => Date.now() });

/** Exactly the RPC methods of design 4.2: every public method here is callable by the main Worker. */
export class AppleProvisioner extends WorkerEntrypoint<ProvisionerEnv> implements AppleRpc {
  createPassType(...a: Parameters<AppleRpc['createPassType']>) {
    return api(this.env).createPassType(...a);
  }
  createCertificate(...a: Parameters<AppleRpc['createCertificate']>) {
    return api(this.env).createCertificate(...a);
  }
  reportCertificateActive(...a: Parameters<AppleRpc['reportCertificateActive']>) {
    return api(this.env).reportCertificateActive(...a);
  }
  listCertificates(...a: Parameters<AppleRpc['listCertificates']>) {
    return api(this.env).listCertificates(...a);
  }
  revokeCertificate(...a: Parameters<AppleRpc['revokeCertificate']>) {
    return api(this.env).revokeCertificate(...a);
  }
  findPassType(...a: Parameters<AppleRpc['findPassType']>) {
    return api(this.env).findPassType(...a);
  }
  calls(...a: Parameters<AppleRpc['calls']>) {
    return api(this.env).calls(...a);
  }
}

export default {
  fetch: () => new Response('Not found', { status: 404 }),
};
