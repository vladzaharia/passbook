import {
  defaultScanDisplay,
  filterDoc,
  migrateScanDisplay,
} from '../../../passkit/template/scan-display/index.ts';
import type {
  ScanDisplayDoc,
  ScanPanelDoc,
  ScanRowDoc,
} from '../../../passkit/template/scan-display/schema.ts';
import type { InputSchema } from '../../../passkit/template/scan-display/scope.ts';
import {
  type Json,
  PASS_STYLES,
  type PassJson,
  type ScanRole,
  type TemplateManifest,
} from '../../../passkit/types.ts';
import type { ScanDisplayScreen } from '../../../shared/contracts/scan-display.ts';
import type { CardPrivacy } from './dto-projection.ts';
import type { Found } from './resolve.ts';

/**
 * The manifest and pass the default document is built from, without the labels and fields whose
 * text is unsafe. Defaults shorten labels while building, so the originals are checked here and
 * the offending field or label is left out rather than the whole display.
 */
export function safeDefaultSources(
  found: Found,
  privacy: CardPrivacy,
): { manifest: TemplateManifest; passJson: PassJson } {
  const manifest = found.template.manifest;
  const properties: Record<string, Json> = {};
  for (const [name, schema] of Object.entries(manifest.inputs.properties ?? {})) {
    const label = schema && typeof schema === 'object' ? (schema as InputSchema)['x-label'] : null;
    if (typeof label === 'string' && !privacy.safe(label)) {
      const { 'x-label': _label, ...rest } = schema as InputSchema;
      properties[name] = rest;
    } else properties[name] = schema as Json;
  }
  // Shallow on purpose: the pass JSON carries credentials, which are never cloned.
  const passJson: Record<string, unknown> = { ...found.passJson };
  for (const style of PASS_STYLES) {
    const block = passJson[style];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const groups: Record<string, unknown> = { ...block };
    for (const group of ['primaryFields', 'secondaryFields', 'auxiliaryFields']) {
      const fields = groups[group];
      if (!Array.isArray(fields)) continue;
      groups[group] = fields.filter((field) => {
        if (!field || typeof field !== 'object' || Array.isArray(field)) return true;
        const { key, label } = field as Record<string, unknown>;
        return !(
          (typeof key === 'string' && !privacy.safe(key)) ||
          (typeof label === 'string' && !privacy.safe(label))
        );
      });
    }
    passJson[style] = groups;
  }
  return {
    manifest: { ...manifest, inputs: { ...manifest.inputs, properties } },
    passJson: passJson as unknown as PassJson,
  };
}

/**
 * A retained display build is not authority to bypass the current display's role
 * restrictions. A panel, row or item must exist for this role in both documents.
 */
export function authorizedDocument(
  found: Found,
  doc: ScanDisplayDoc,
  role: ScanRole,
  terminal: boolean,
  screen: ScanDisplayScreen,
): ScanDisplayDoc {
  const selected = filterDoc(migrateScanDisplay(doc), role, terminal);
  const current = found.activePolicy ?? found.activeTemplate ?? found.template;
  if (current === found.template) return selected;
  const originals = [found.template, current].map((template) =>
    migrateScanDisplay(
      template.manifest.scan?.display ?? defaultScanDisplay(template.manifest, found.passJson),
    ),
  );
  const policies = originals.map((policy) => filterDoc(policy, role, terminal));
  if (originals.some((policy, index) => policy.photo && !policies[index]?.photo))
    delete selected.photo;

  const header = (
    own: ScanDisplayDoc['header'],
    peers: ScanDisplayDoc['header'][],
  ): ScanDisplayDoc['header'] => {
    const result = { ...own };
    for (const key of ['icon', 'title', 'subtitle'] as const)
      if (peers.some((peer) => peer[key] == null)) delete result[key];
    if (own.chips)
      result.chips = own.chips.filter((chip) =>
        peers.every((peer) => peer.chips?.some((candidate) => candidate.id === chip.id)),
      );
    return result;
  };
  selected.header = header(
    selected.header,
    policies.map((policy) => policy.header),
  );
  if (selected.variants)
    selected.variants = selected.variants.flatMap((variant) => {
      const peers = policies.map((policy) =>
        policy.variants?.find((item) => item.id === variant.id),
      );
      if (!peers.every((peer): peer is NonNullable<typeof peer> => !!peer)) return [];
      return [
        {
          ...variant,
          header: header(
            variant.header,
            peers.map((peer) => peer.header),
          ),
        },
      ];
    });
  if (selected.panels)
    selected.panels = selected.panels.flatMap((panel): ScanPanelDoc[] => {
      const peers = policies.map((policy) => policy.panels?.find((item) => item.id === panel.id));
      if (
        !peers.every((peer): peer is NonNullable<typeof peer> => !!peer) ||
        peers.some((peer) => screen !== 'refused' && peer.on && !peer.on.includes(screen))
      )
        return [];
      const rows = panel.rows.flatMap((row): ScanRowDoc[] => {
        const matches = peers.map((peer) =>
          peer.rows.find((item) => item.id === row.id && item.type === row.type),
        );
        if (matches.some((match) => !match)) return [];
        if (row.type === 'chips') {
          const items = row.items.filter((item) =>
            matches.every(
              (match) =>
                match?.type === 'chips' &&
                match.items.some((candidate) => candidate.id === item.id),
            ),
          );
          return items.length ? [{ ...row, items }] : [];
        }
        if (row.type === 'list') {
          const items = row.items.filter((item) =>
            matches.every(
              (match) =>
                match?.type === 'list' && match.items.some((candidate) => candidate.id === item.id),
            ),
          );
          return items.length ? [{ ...row, items }] : [];
        }
        return [row];
      });
      if (!rows.length) return [];
      const result = { ...panel, rows };
      for (const key of ['title', 'icon', 'tone'] as const)
        if (peers.some((peer) => peer?.[key] == null)) delete result[key];
      return [result];
    });
  if (selected.notes) {
    const notes = { ...selected.notes };
    for (const key of ['staff', 'refused'] as const)
      if (policies.some((policy) => policy.notes?.[key] == null)) delete notes[key];
    selected.notes = notes;
  }
  return selected;
}
