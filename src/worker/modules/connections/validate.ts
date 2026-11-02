import type { ZodType, z } from 'zod';
import { isPointer } from '../../connectors/lib/pointer.ts';
import { connectors } from '../../connectors/registry.ts';
import type { AnyConnector } from '../../connectors/types.ts';
import { type FieldIssue, ValidationError } from '../../platform/errors.ts';
import { assertPublicHost, assertSafeUrl, platformHostsOf } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { getDeps, resolverOf } from './deps.ts';
import type { Mode } from './repo.ts';
import { templateScope } from './repo-passes.ts';

export function issuesOf(prefix: string, error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].join('.'),
    message: i.message,
    code: i.code,
  }));
}

export function requireConnector(type: string): AnyConnector {
  const def = connectors.get(type);
  if (!def)
    throw new ValidationError(
      'Unknown connector type.',
      [{ path: 'connectorType', message: 'Unknown connector type.' }],
      'CONNECTOR_UNKNOWN',
    );
  return def;
}

export function parseWith<T>(schema: ZodType<T>, value: unknown, prefix: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ValidationError('The connection is invalid.', issuesOf(prefix, result.error));
  return result.data;
}

export function assertModeSupported(def: AnyConnector, mode: Mode): void {
  const caps = def.capabilities;
  const ok =
    mode === 'manual' ||
    (mode === 'poll' && caps.poll === true) ||
    (mode === 'webhook' && caps.webhook === true) ||
    (mode === 'hybrid' && caps.poll === true && caps.webhook === true) ||
    (mode === 'snapshot' && caps.snapshot === true);
  if (!ok) {
    throw new ValidationError(
      `${def.displayName} does not support mode ${mode}.`,
      [{ path: 'mode', message: 'Mode not supported by this connector.' }],
      'MODE_UNSUPPORTED',
    );
  }
}

/** Rejects URLs that break the SSRF rules (static checks plus DNS) before they are stored. */
export async function assertSafeUrls(sctx: ServiceContext, urls: string[]): Promise<void> {
  const platformHosts = platformHostsOf(sctx.env);
  const resolver = resolverOf(getDeps());
  for (const raw of urls) {
    try {
      const url = assertSafeUrl(raw, platformHosts);
      await assertPublicHost(url.hostname, resolver);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError(
          error.message,
          [{ path: 'config', message: error.message, code: 'UNSAFE_URL' }],
          'UNSAFE_URL',
        );
      }
      throw error;
    }
  }
}

export function assertPointer(value: string | undefined, path: string): void {
  if (value !== undefined && !isPointer(value)) {
    throw new ValidationError('Not a JSON pointer.', [{ path, message: 'Not a JSON pointer.' }]);
  }
}

/** The template must exist, be active and belong to the connection's org (or be platform-wide). */
export async function assertTemplateUsable(
  sctx: ServiceContext,
  orgId: string,
  templateId: string,
): Promise<void> {
  const scope = await templateScope(sctx.env.DB, templateId);
  if (scope?.status !== 'active' || (scope.orgId !== null && scope.orgId !== orgId)) {
    throw new ValidationError(
      'Template not found.',
      [{ path: 'defaultTemplateId', message: 'Template not found.' }],
      'TEMPLATE_NOT_FOUND',
    );
  }
}

export async function assertOrg(sctx: ServiceContext, orgId: string): Promise<void> {
  if (!(await orgIsActive(sctx.env.DB, orgId))) {
    throw new ValidationError(
      'Organization not found.',
      [{ path: 'orgId', message: 'Organization not found.' }],
      'ORG_NOT_FOUND',
    );
  }
}
