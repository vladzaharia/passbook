import {
  type InputSchema,
  inputProps,
  inputVisibleTo,
  secretInputs,
} from '../../../passkit/template/scan-display/scope.ts';
import type { ScanRole, TemplateManifest } from '../../../passkit/types.ts';
import { type ResolvedScanAction, scanOf } from '../../../shared/scan-defaults.ts';
import { verifyEventActionLabelHash } from './event-safe-projection.ts';
import { historyTitleVisible } from './history-policy-title.ts';
import { scanPrivateName } from './projection-privacy.ts';
import { ROLE_RANK } from './rules.ts';
import type { ScanEventReference } from './scan-event-proof.ts';

type ObjectValue = Record<string, unknown>;
type Manifest = { version: string; manifest: TemplateManifest };

interface EvaluationInput {
  keys: object;
  scan: ScanEventReference;
  role: ScanRole;
  signedAction: { kind: string; labelHash: string } | null;
  currentPinned: Manifest;
  currentActive: Manifest;
  eventWallet: Manifest | null;
  selected: 'current' | 'version';
  currentTitle: string | null;
  titleCommitted: boolean;
  currentScannerName: string | null;
  scannerNameCommitted: boolean;
  manifests: TemplateManifest[];
  historical: ObjectValue;
  current: ObjectValue;
  privateValues: readonly string[] | undefined;
}

const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;

function schemaOf(value: unknown): InputSchema | null {
  const schema = object(value);
  return schema ? (schema as InputSchema) : null;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const PHONE = /(?:^|[^\d])\+?\d[\d ().-]{6,}\d(?:$|[^\d])/u;
const CONTACT_URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|www\.)/i;

/** Build disclosure decisions from the captured and authenticated history inputs. */
export async function evaluatedHistoryPolicy({
  keys,
  scan,
  role,
  signedAction,
  currentPinned,
  currentActive,
  eventWallet,
  selected,
  currentTitle,
  titleCommitted,
  currentScannerName,
  scannerNameCommitted,
  manifests,
  historical,
  current,
  privateValues,
}: EvaluationInput) {
  let committedActionLabel: string | null = null;
  if (
    signedAction &&
    scan.actionId !== null &&
    scan.passId !== null &&
    signedAction.kind === scan.actionKind
  ) {
    let candidates: ResolvedScanAction[];
    try {
      candidates = [currentPinned, currentActive].flatMap(({ manifest }) =>
        scanOf(manifest).actions.filter((action) => action.id === scan.actionId),
      );
    } catch {
      return null;
    }
    for (const candidate of candidates) {
      if (candidate.kind !== signedAction.kind || typeof candidate.label !== 'string') continue;
      if (
        await verifyEventActionLabelHash(keys, {
          orgId: scan.orgId,
          passId: scan.passId,
          scanId: scan.id,
          role,
          actionId: candidate.id,
          kind: candidate.kind,
          label: candidate.label,
          hash: signedAction.labelHash,
        })
      ) {
        committedActionLabel = candidate.label;
        break;
      }
    }
  }
  try {
    const policyOf = (manifest: TemplateManifest) => ({
      manifest,
      properties: inputProps(manifest),
      secrets: secretInputs(manifest),
      actions: scanOf(manifest).actions,
    });
    const policies = manifests.map(policyOf);
    const walletPolicies: typeof policies = [];
    try {
      if (eventWallet) walletPolicies.push(policyOf(eventWallet.manifest));
    } catch {
      /* Unusable Wallet policy. */
    }
    const walletPolicy = walletPolicies[0] ?? null;
    if (selected === 'version' && !walletPolicy) return null;
    if (selected === 'version' && walletPolicy) policies.push(walletPolicy);
    const sources = historical === current ? [historical] : [historical, current];
    const allowed = (name: string, schema: InputSchema | null, secrets: Set<string>): boolean =>
      schema !== null && !scanPrivateName(name) && inputVisibleTo(name, schema, role, secrets);
    const fullyVisible = (
      name: string,
      value: unknown,
      schema: InputSchema | null,
      secrets: Set<string>,
    ): boolean => {
      if (!allowed(name, schema, secrets) || !schema) return false;
      if (Array.isArray(value)) {
        const item = schemaOf(schema.items);
        return value.every((entry) => fullyVisible(name, entry, item, secrets));
      }
      const record = object(value);
      if (!record) return true;
      const children = object(schema.properties);
      return Object.entries(record).every(([key, child]) =>
        fullyVisible(key, child, schemaOf(children?.[key]), secrets),
      );
    };
    const visibility = (policySet: typeof policies) => {
      const inputVisible = (path: string): boolean => {
        const parts = path.split('.');
        const last = parts.at(-1);
        if (!last || parts.some((part) => !part)) return false;
        return policySet.every(({ properties, secrets }) =>
          sources.every((source) => {
            let value: unknown = source;
            let schema: InputSchema | null = null;
            for (const [i, key] of parts.entries()) {
              const record = object(value);
              if (!record || !Object.hasOwn(record, key)) return false;
              const children = i === 0 ? properties : object(schema?.properties);
              schema = schemaOf(children?.[key]);
              if (!allowed(key, schema, secrets)) return false;
              value = record[key];
            }
            return fullyVisible(last, value, schema, secrets);
          }),
        );
      };
      const denied: (string | number | boolean)[] = [...(privateValues ?? [])];
      const collect = (value: unknown): void => {
        if (typeof value === 'string' && value) denied.push(value);
        else if (typeof value === 'number' || typeof value === 'boolean') denied.push(value);
        else if (Array.isArray(value))
          value.forEach((item) => {
            collect(item);
          });
        else if (object(value))
          Object.values(value as ObjectValue).forEach((item) => {
            collect(item);
          });
      };
      for (const { properties, secrets } of policySet) {
        const defaults = (name: string, schema: InputSchema | null, hidden: boolean): void => {
          if (!schema) return;
          const deniedHere = hidden || !allowed(name, schema, secrets);
          if (deniedHere) collect(schema.default);
          const children = object(schema.properties);
          if (children)
            for (const [key, child] of Object.entries(children))
              defaults(key, schemaOf(child), deniedHere);
          if (schema.items) defaults(name, schemaOf(schema.items), deniedHere);
        };
        for (const [name, schema] of Object.entries(properties))
          defaults(name, schemaOf(schema), false);
      }
      for (const { properties, secrets } of policySet)
        for (const source of sources) {
          const visit = (name: string, value: unknown, schema: InputSchema | null): void => {
            if (!allowed(name, schema, secrets) || !schema) {
              collect(value);
              return;
            }
            if (Array.isArray(value))
              value.forEach((item) => {
                visit(name, item, schemaOf(schema.items));
              });
            else {
              const record = object(value);
              if (record) {
                const children = object(schema.properties);
                for (const [key, child] of Object.entries(record))
                  visit(key, child, schemaOf(children?.[key]));
              }
            }
          };
          for (const [name, value] of Object.entries(source))
            visit(name, value, schemaOf(properties[name]));
        }
      const protectedStrings = denied.flatMap((value) => {
        const text = String(value);
        return [
          text,
          text
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;'),
          encodeURIComponent(text.toWellFormed()),
        ];
      });
      const valueSafe = (value: unknown): boolean => {
        if (typeof value === 'string')
          return (
            !EMAIL.test(value) &&
            !CONTACT_URL.test(value) &&
            (/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) || !PHONE.test(value)) &&
            !protectedStrings.some((secret) =>
              secret.length < 3 ? value === secret : value.includes(secret),
            )
          );
        if (typeof value === 'number' || typeof value === 'boolean') return !denied.includes(value);
        if (Array.isArray(value)) return value.every(valueSafe);
        const record = object(value);
        return record
          ? Object.entries(record).every(
              ([key, child]) => !scanPrivateName(key) && valueSafe(child),
            )
          : true;
      };
      return { inputVisible, valueSafe };
    };
    const { inputVisible, valueSafe } = visibility(policies);
    const titlePolicies =
      selected === 'version' || !walletPolicy ? policies : [...policies, walletPolicy];
    const titleSafety = walletPolicy ? visibility(titlePolicies) : null;
    return {
      inputVisible(path: string) {
        try {
          return typeof path === 'string' && inputVisible(path);
        } catch {
          return false;
        }
      },
      valueSafe(value: unknown) {
        try {
          return valueSafe(value);
        } catch {
          return false;
        }
      },
      action(id: string | null, kind: string | null) {
        try {
          if (
            !id ||
            !kind ||
            id !== scan.actionId ||
            kind !== scan.actionKind ||
            !signedAction ||
            signedAction.kind !== kind ||
            committedActionLabel === null
          )
            return null;
          const actions = policies.map(({ actions }) =>
            actions.find((action) => action?.id === id),
          );
          const active = actions[3];
          if (
            !active ||
            typeof active.label !== 'string' ||
            (active.input !== undefined && typeof active.input !== 'string') ||
            actions.some(
              (action) =>
                !action ||
                action.kind !== kind ||
                action.input !== active.input ||
                !Object.hasOwn(ROLE_RANK, action.minRole) ||
                ROLE_RANK[role] < ROLE_RANK[action.minRole],
            )
          )
            return null;
          if (active.input && !inputVisible(active.input)) return null;
          return valueSafe(active.id) && valueSafe(committedActionLabel)
            ? { ...active, label: committedActionLabel }
            : null;
        } catch {
          return null;
        }
      },
      titleVisible(title: string | null) {
        return historyTitleVisible(
          title,
          titleCommitted,
          currentTitle,
          titleSafety,
          currentPinned,
          current,
          titlePolicies,
        );
      },
      scannerNameVisible(name: string | null) {
        try {
          return (
            name !== null && name === currentScannerName && scannerNameCommitted && valueSafe(name)
          );
        } catch {
          return false;
        }
      },
    };
  } catch {
    return null;
  }
}
