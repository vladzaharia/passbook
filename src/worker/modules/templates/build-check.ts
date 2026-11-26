import { behaviorPlugins } from '../../../generated/behaviors.ts';
import { createBehaviorRegistry } from '../../../passkit/behaviors/registry.ts';
import { buildPass, PassBuildError, type PlannedPass, planPass } from '../../../passkit/build.ts';
import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import type {
  PassIdentity,
  PassJson,
  Personalization,
  ValidationIssue,
} from '../../../passkit/types.ts';
import type { AppEnv } from '../../platform/env.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { Logger } from '../../platform/log.ts';
import { resolveDefaultPlatform } from '../identities/db-resolver.ts';
import { defaultPlatformPassIdentity } from '../identities/repo-platform-default.ts';

export const behaviors = createBehaviorRegistry([...behaviorPlugins]);

/** What `{{pass.scanCode}}` reads in previews and dry runs: shaped like a real code (26 base32). */
export const PREVIEW_SCAN_CODE = 'PREVIEW2PASS3SCAN4CODE5XYZ';

/** The env pass type, until a caller that can read the database passes the default platform row's. */
function platformIdentity(env: AppEnv): PassIdentity {
  return { passTypeIdentifier: env.PLATFORM_PASS_TYPE_ID, teamIdentifier: env.PLATFORM_TEAM_ID };
}

/** The pass type and team new platform passes carry: the default platform row, else the env values. */
export function defaultPassIdentity(env: AppEnv): Promise<PassIdentity> {
  return defaultPlatformPassIdentity(env.DB, platformIdentity(env));
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

/** The plan of a real build (defaults, behaviors, normalize, shipped assets), without signing. */
export function previewPlan(
  env: AppEnv,
  template: ResolvedTemplate,
  input: Personalization,
  organizationName: string,
  now: Date,
  /** The org's zone, for behaviors whose template names none; a shared template keeps the default. */
  timeZone?: string,
  identity: PassIdentity = platformIdentity(env),
): PlannedPass {
  return planPass({
    template,
    registry: noRegistry,
    input,
    server: {
      serial: 'preview',
      authToken: 'preview-token-000000000000000000',
      webServiceURL: `${baseUrl(env)}/wallet`,
      organizationName,
      identity,
      scanCode: PREVIEW_SCAN_CODE,
    },
    signing: undefined as never,
    behaviors,
    now,
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Same pipeline as a real build, without signing. */
export function previewPass(
  env: AppEnv,
  template: ResolvedTemplate,
  input: Personalization,
  organizationName: string,
  now: Date,
  timeZone?: string,
  identity?: PassIdentity,
): PreviewResult {
  const plan = previewPlan(env, template, input, organizationName, now, timeZone, identity);
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
  log: Logger,
): Promise<ValidationIssue[]> {
  const input = template.manifest.sample;
  try {
    const identity = await resolveDefaultPlatform(env);
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
        scanCode: PREVIEW_SCAN_CODE,
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
    if (error instanceof AppError) {
      return [{ severity: 'error', code: 'DRY_RUN_FAILED', message: error.message }];
    }
    // Infrastructure failure, not a template problem: let the step retry instead of blaming the upload.
    log.error('templates.dry_run_failed', { code: 'DRY_RUN_FAILED', error });
    throw error;
  }
}
