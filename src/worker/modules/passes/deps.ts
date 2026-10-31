import { behaviorPlugins } from '../../../generated/behaviors.ts';
import { type BehaviorRegistry, createBehaviorRegistry } from '../../../passkit/index.ts';
import type { TemplateRegistry } from '../../../passkit/template/registry.ts';
import type { AppEnv } from '../../platform/env.ts';
import { type ApnsTransport, createMtlsApnsTransport } from '../delivery/apns.ts';
import { createEmailBindingMailer, type Mailer } from '../delivery/mailer.ts';
import { createIdentityResolver, type IdentityResolver } from '../identities/resolver.ts';
import { createTemplateRegistry } from '../templates/registry.ts';

/** Collaborators behind ports. Tests replace them per env object with `overrideDeps`. */
export interface Deps {
  registry: TemplateRegistry;
  identities: IdentityResolver;
  apns: ApnsTransport;
  mailer: Mailer;
  behaviors: BehaviorRegistry;
}

const cache = new WeakMap<object, Deps>();
const overrides = new WeakMap<object, Partial<Deps>>();

export function depsOf(env: AppEnv): Deps {
  const override = overrides.get(env);
  let base = cache.get(env);
  if (!base) {
    base = {
      registry: createTemplateRegistry(env),
      identities: createIdentityResolver(env),
      apns: createMtlsApnsTransport(env),
      mailer: createEmailBindingMailer(env),
      behaviors: createBehaviorRegistry([...behaviorPlugins]),
    };
    cache.set(env, base);
  }
  return override ? { ...base, ...override } : base;
}

export function overrideDeps(env: AppEnv, partial: Partial<Deps>): void {
  overrides.set(env, { ...overrides.get(env), ...partial });
}
