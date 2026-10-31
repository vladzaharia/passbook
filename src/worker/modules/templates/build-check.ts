import { behaviorPlugins } from '../../../generated/behaviors.ts';
import { createBehaviorRegistry } from '../../../passkit/behaviors/registry.ts';
import { applyBindings, buildPass, PassBuildError, validateInput } from '../../../passkit/build.ts';
import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import type {
  PassIdentity,
  PassJson,
  Personalization,
  ValidationIssue,
} from '../../../passkit/types.ts';
import { validatePass } from '../../../passkit/validate.ts';
import type { AppEnv } from '../../platform/env.ts';
import { baseUrl } from '../../platform/env.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createEnvIdentityResolver } from '../identities/resolver.ts';

export const behaviors = createBehaviorRegistry([...behaviorPlugins]);

function stripDesignerIds(value: unknown): void {
  if (Array.isArray(value)) value.forEach(stripDesignerIds);
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    delete record._id;
    Object.values(record).forEach(stripDesignerIds);
  }
}

function platformIdentity(env: AppEnv): PassIdentity {
  return { passTypeIdentifier: env.PLATFORM_PASS_TYPE_ID, teamIdentifier: env.PLATFORM_TEAM_ID };
}

export interface PreviewResult {
  passJson: PassJson;
  issues: ValidationIssue[];
}

/** Bindings, behaviors and validation for `input`, without signing. Throws PassBuildError on bad input. */
export function previewPass(
  env: AppEnv,
  template: ResolvedTemplate,
  input: Personalization,
  organizationName: string,
  now: Date,
): PreviewResult {
  validateInput(template, input);
  const pass = applyBindings(template, input);
  const identity = platformIdentity(env);
  for (const use of template.manifest.behaviors ?? []) {
    const plugin = behaviors.get(use.use);
    if (!plugin)
      throw new PassBuildError('BEHAVIOR', `Unknown behavior ${use.use}.`, [
        { severity: 'error', code: 'BEHAVIOR', message: `Unknown behavior ${use.use}.` },
      ]);
    plugin.apply(pass, input, use.config, {
      now,
      identity,
      lookups: template.manifest.lookups ?? {},
    });
  }
  stripDesignerIds(pass);
  pass.formatVersion = 1;
  pass.passTypeIdentifier = identity.passTypeIdentifier;
  pass.teamIdentifier = identity.teamIdentifier;
  pass.serialNumber = 'preview';
  pass.organizationName = organizationName;
  return { passJson: pass, issues: validatePass(pass, template.assets, identity).issues };
}

/** Builds and signs once with the platform identity so broken templates fail at upload. */
export async function dryRun(
  env: AppEnv,
  template: ResolvedTemplate,
  readAsset: (name: string) => Promise<Uint8Array>,
  organizationName: string,
  now: Date,
): Promise<ValidationIssue[]> {
  const input = template.manifest.sample;
  try {
    const identity = await createEnvIdentityResolver(env).platform();
    const registry: TemplateRegistry = {
      list: async () => [],
      resolve: async () => template,
      openAsset: async (_t, name) =>
        new Response(await readAsset(name)).body as ReadableStream<Uint8Array>,
    };
    const built = await buildPass({
      template,
      registry,
      input,
      server: {
        serial: 'dry-run',
        authToken: 'dry-run-token-0000000000000000',
        webServiceURL: `${baseUrl(env)}/wallet`,
        organizationName,
        identity,
      },
      signing: identity.material,
      behaviors,
      now,
    });
    return built.report.issues;
  } catch (error) {
    if (error instanceof PassBuildError) return error.report.issues;
    if (error instanceof NotFoundError && error.code === 'IDENTITY_NOT_CONFIGURED') {
      const skipped: ValidationIssue = {
        severity: 'warning',
        code: 'DRY_RUN_UNSIGNED',
        message: 'Platform signing identity is not configured; signing was skipped.',
      };
      try {
        return [...previewPass(env, template, input, organizationName, now).issues, skipped];
      } catch (inner) {
        if (inner instanceof PassBuildError) return [...inner.report.issues, skipped];
        throw inner;
      }
    }
    return [
      {
        severity: 'error',
        code: 'DRY_RUN_FAILED',
        message: error instanceof Error ? error.message : 'Dry-run build failed.',
      },
    ];
  }
}
