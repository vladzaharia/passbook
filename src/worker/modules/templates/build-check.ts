import { behaviorPlugins } from '../../../generated/behaviors.ts';
import { createBehaviorRegistry } from '../../../passkit/behaviors/registry.ts';
import { buildPass, PassBuildError, planPass } from '../../../passkit/build.ts';
import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import type {
  PassIdentity,
  PassJson,
  Personalization,
  ValidationIssue,
} from '../../../passkit/types.ts';
import type { AppEnv } from '../../platform/env.ts';
import { baseUrl } from '../../platform/env.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createIdentityResolver } from '../identities/resolver.ts';

export const behaviors = createBehaviorRegistry([...behaviorPlugins]);

function platformIdentity(env: AppEnv): PassIdentity {
  return { passTypeIdentifier: env.PLATFORM_PASS_TYPE_ID, teamIdentifier: env.PLATFORM_TEAM_ID };
}

const noRegistry: TemplateRegistry = {
  list: async () => [],
  resolve: async () => {
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  },
  openAsset: async () => {
    throw new NotFoundError('Asset not found.', 'ASSET_NOT_FOUND');
  },
};

export interface PreviewResult {
  passJson: PassJson;
  issues: ValidationIssue[];
}

/** Same pipeline as a real build (defaults, behaviors, normalize, shipped assets), without signing. */
export function previewPass(
  env: AppEnv,
  template: ResolvedTemplate,
  input: Personalization,
  organizationName: string,
  now: Date,
): PreviewResult {
  const plan = planPass({
    template,
    registry: noRegistry,
    input,
    server: {
      serial: 'preview',
      authToken: 'preview-token-000000000000000000',
      webServiceURL: `${baseUrl(env)}/wallet`,
      organizationName,
      identity: platformIdentity(env),
    },
    signing: undefined as never,
    behaviors,
    now,
  });
  const { authenticationToken: _token, ...passJson } = plan.passJson;
  return { passJson, issues: plan.report.issues };
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
    const identity = await createIdentityResolver(env).platform();
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
