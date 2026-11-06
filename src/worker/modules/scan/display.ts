import {
  actionGoals,
  defaultScanDisplay,
  renderScanDisplay,
  type ScanDisplayNeeds,
  type ScanDisplayScope,
} from '../../../passkit/template/scan-display/index.ts';
import {
  hiddenFieldKeys,
  inputProps,
  inputVisibleTo,
  passFields,
  secretInputs,
} from '../../../passkit/template/scan-display/scope.ts';
import type { Json } from '../../../passkit/types.ts';
import type { ScanDisplay, ScanDisplayScreen } from '../../../shared/contracts/scan-display.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { planHistory } from './repo-history.ts';
import type { Found } from './resolve.ts';

export interface BuildDisplayInput {
  actor: ScanActor;
  pass: { id: string; title: string } | null;
  screen: ScanDisplayScreen;
  card?: unknown;
  template?: Found;
  scan?: Json;
  history?: unknown;
}
export interface HistoryReader {
  stmts: D1PreparedStatement[];
  read(results: D1Result[]): unknown;
}

function identity(input: BuildDisplayInput): ScanDisplay | null {
  if (!input.pass) return null;
  const holder = input.pass.title.slice(0, 40);
  return {
    v: 1,
    screen: input.screen,
    templateVersion: '',
    variant: null,
    identity: {
      holder,
      initials: holder
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => Array.from(w)[0])
        .join('')
        .toUpperCase(),
      photo: null,
    },
    header: { icon: null, title: null, titleLines: 1, meta: null, chips: [] },
    panels: [],
    notes: { staff: null, refused: null },
  };
}

/** Build the scope before rendering: secrets and fields above the actor's role never enter it. */
function scopeOf(ctx: ServiceContext, input: BuildDisplayInput, found: Found): ScanDisplayScope {
  const { actor } = input;
  const { pass, passJson, template } = found;
  const manifest = template.manifest;
  const role = actor.role ?? 'door';
  const props = inputProps(manifest);
  const secrets = secretInputs(manifest);
  const inputs = Object.fromEntries(
    Object.entries(pass.personalization).filter(([key]) =>
      inputVisibleTo(key, props[key] ?? {}, role, secrets),
    ),
  );
  const denied = new Set([
    ...secrets,
    ...Object.keys(props).filter((key) => !inputVisibleTo(key, props[key] ?? {}, role, secrets)),
  ]);
  const hidden = hiddenFieldKeys(manifest, passJson, denied);
  const validity = validityOf(passJson, ctx.clock.now());
  return {
    inputs,
    fields: Object.fromEntries(
      passFields(passJson)
        .filter((f) => !hidden.has(f.key))
        .map((f) => [f.key, f.value as Json]),
    ),
    pass: {
      title: pass.displayTitle ?? '',
      subtitle: pass.displaySubtitle,
      status: validity.status,
      statusLabel: validity.status,
      validFrom: validity.validFrom,
      validUntil: validity.validUntil,
      createdAt: pass.createdAt,
      version: pass.version,
      templateName: found.ref.name,
      style: found.ref.style,
      externalId: role === 'door' ? null : pass.externalId,
    },
    scan: input.scan ?? {
      outcome: input.screen,
      at: ctx.clock.now(),
      direction: found.admission?.state.direction ?? 'in',
    },
    history: (input.history ?? {}) as Json,
    event: actor.event
      ? {
          name: actor.event.name,
          opensAt: actor.event.opensAt,
          closesAt: actor.event.closesAt,
          capacity: actor.event.capacity,
        }
      : null,
    scanner: { name: actor.name, role },
    lookups: manifest.lookups ?? {},
    goals: actionGoals(manifest),
    assets: found.photoUrl && actor.settings.showPhoto !== false ? { photo: found.photoUrl } : {},
    templateVersion: String(template.version),
    now: ctx.clock.now(),
  };
}

/** A broken display cannot interrupt a door decision. */
export function buildDisplay(ctx: ServiceContext, input: BuildDisplayInput): ScanDisplay | null {
  if (!input.pass) return null;
  const found = input.template;
  if (!found) return identity(input);
  const options = {
    screen: input.screen,
    role: input.actor.role ?? 'door',
    terminal: input.actor.terminal,
    locale: 'en',
    timeZone: input.actor.timeZone,
    now: ctx.clock.now(),
  };
  const configured =
    found.scan.display ?? defaultScanDisplay(found.template.manifest, found.passJson);
  const doc =
    found.photoUrl && input.actor.settings.showPhoto !== false && !configured.photo
      ? { ...configured, photo: {} }
      : configured;
  try {
    return renderScanDisplay(doc, scopeOf(ctx, input, found), options);
  } catch (error) {
    ctx.log.error('scan.display_failed', {
      code: 'SCAN_DISPLAY_FAILED',
      passId: input.pass.id,
      error,
    });
    try {
      return renderScanDisplay(
        defaultScanDisplay(found.template.manifest, found.passJson),
        scopeOf(ctx, input, found),
        options,
      );
    } catch (fallbackError) {
      ctx.log.error('scan.display_fallback_failed', {
        code: 'SCAN_DISPLAY_FALLBACK_FAILED',
        passId: input.pass.id,
        error: fallbackError,
      });
      return identity(input);
    }
  }
}

export function historyStatements(
  db: D1Database,
  needs: ScanDisplayNeeds,
  scope: { passId: string; orgId: string; timeZone: string; now: number },
): HistoryReader {
  return planHistory(db, needs, scope);
}
