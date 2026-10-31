import type { Env, Personalization } from '../types.ts';
export interface SourceContext {
  reference: string;
  current: Personalization;
  env: Env;
  fetch: typeof fetch;
}
export interface UpdateSource {
  id: string;
  intervalSeconds: number;
  refresh(context: SourceContext): Promise<Partial<Personalization>>;
}
