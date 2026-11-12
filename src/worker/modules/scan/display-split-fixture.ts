import { beforeAll } from 'vitest';
import { makeEnv, makeTemplate } from '../../../../test/helpers/index.ts';
import type { ScanDisplayDoc } from '../../../passkit/template/scan-display/schema.ts';
import type { PassJson, ScanRole } from '../../../passkit/types.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import type { ScanActor } from './actor.ts';
import type { BuildDisplayInput } from './display.ts';
import type { Found } from './resolve.ts';

export const NOW = Date.UTC(2026, 10, 5, 18);
export const SECRET = 'hidden&<secret>-95731';
export const ESCAPED_SECRET = 'hidden&amp;&lt;secret&gt;-95731';
export const ENCODED_SECRET = encodeURIComponent(SECRET);
export const NESTED = 'nested hidden orange';
export const MANAGER = 'Roof Atrium';
export const EMAIL = 'contact@example.test';
export const PHONE = '+447911867530';
export const BARCODE = 'barcode-private-6835';
export const SCAN_CODE = 'scan-private-6294';
export const AUTH = 'auth-private-3152';
export const DOWNLOAD = 'download-private-9063';
export const SERIAL = 'serial-private-2974';
export const HIDDEN_COUNT = 918273645;

export const ctx = {
  clock: { now: () => NOW },
  log: { error: () => {} },
} as unknown as ServiceContext;

export function createDisplayFixture() {
  let keysetCommitment: string;
  let otherKeysetCommitment: string;
  beforeAll(async () => {
    const env = await makeEnv();
    keysetCommitment = await ensureCredentialRefKeyset(env.DB, env);
    otherKeysetCommitment = await credentialRefKeysetCommitment({ KEK_V1: btoa('a'.repeat(32)) });
  });

  const actorOf = (role: ScanRole): ScanActor =>
    ({
      principal: 'scanner',
      orgId: 'org-1',
      mode: 'live',
      actorKey: 's:scanner-1',
      credentialKeysetCommitment: keysetCommitment,
      actor: { type: 'scanner', id: 'scanner-1' },
      scanner: null,
      templateIds: [],
      staff: null,
      role,
      name: 'Front door',
      event: null,
      terminal: false,
      timeZone: 'UTC',
      settings: { showPhoto: true },
    }) as unknown as ScanActor;

  function fixture(): Found {
    const template = makeTemplate().resolved;
    template.manifest.inputs.properties = {
      memberName: { type: 'string' },
      seat: { type: 'string' },
      tier: { type: 'string', 'x-scan': 'desk' },
      points: { type: 'integer', 'x-scan': 'desk' },
      profile: {
        type: 'object',
        properties: {
          publicLabel: { type: 'string' },
          managerHint: { type: 'string', 'x-scan': 'manager' },
          internalNote: { type: 'string', 'x-scan': 'hidden' },
          nestedContact: { type: 'string', format: 'email' },
        },
      },
      privateNotes: { type: 'string', 'x-scan': 'hidden' },
      hiddenCount: { type: 'integer', 'x-scan': 'hidden' },
      contact: { type: 'string', format: 'email', 'x-scan': 'door' },
      callback: { type: 'string', 'x-widget': 'tel', 'x-scan': 'door' },
      ticketNumber: { type: 'string' },
    };
    template.manifest.bindings = [
      { to: { field: 'name' }, value: '{{memberName}}' },
      { to: { field: 'seat' }, value: '{{seat}}' },
      { to: { field: 'tier' }, value: '{{tier}}' },
      { to: { field: 'nested_manager' }, value: '{{profile.managerHint}}' },
      { to: { field: 'nested_note' }, value: '{{profile.internalNote}}' },
      { to: { field: 'notes' }, value: '{{privateNotes}}' },
      {
        to: { field: 'conditional' },
        value: { const: 'Available' },
        when: { input: 'privateNotes', eq: SECRET },
      },
      { to: { field: 'scan_ref' }, value: '{{pass.scanCode}}' },
      { to: { barcode: 0, prop: 'message' }, value: '{{ticketNumber}}' },
    ];
    template.manifest.lookups = {
      directory: {
        public: { label: 'Atrium access' },
        [EMAIL]: { label: 'Contact entry' },
        [SECRET]: { label: 'Secret entry' },
        mirror: { label: `Copied: ${SECRET}` },
      },
    };
    const display: ScanDisplayDoc = {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: {},
      panels: [
        {
          id: 'p_details',
          rows: [
            { id: 'r_seat', type: 'field', label: 'Seat', value: '{{fields.seat}}' },
            { id: 'r_tier', type: 'field', label: 'Tier', value: '{{fields.tier}}' },
            { id: 'r_manager', type: 'field', label: 'Room', value: '{{fields.nested_manager}}' },
          ],
        },
      ],
    };
    template.manifest.scan = {
      actions: [
        { id: 'check_in', label: 'Check in', kind: 'check_in' },
        { id: 'points', label: 'Points', kind: 'add', input: 'points' },
      ],
      display,
    };
    const passJson = {
      ...template.passJson,
      serialNumber: SERIAL,
      authenticationToken: AUTH,
      webServiceURL: 'https://wallet.test/private-service',
      barcodes: [{ format: 'PKBarcodeFormatQR', message: BARCODE, messageEncoding: 'utf-8' }],
      generic: {
        primaryFields: [{ key: 'name', value: 'Ada North' }],
        secondaryFields: [
          { key: 'seat', value: 'C12' },
          { key: 'tier', value: 'Gold' },
          { key: 'nested_manager', value: MANAGER },
        ],
        backFields: [
          { key: 'nested_note', value: NESTED },
          { key: 'notes', value: SECRET },
          { key: 'mirror', value: `Copied: ${SECRET}` },
          { key: 'mirror_html', value: `Copied: ${ESCAPED_SECRET}` },
          { key: 'mirror_url', value: `Copied: ${ENCODED_SECRET}` },
          { key: 'unknown_copy', value: 'undeclared sensitive value' },
          { key: 'conditional', value: 'Available' },
          { key: 'count_copy', value: HIDDEN_COUNT },
          { key: 'scan_ref', value: SCAN_CODE },
          { key: 'barcode_copy', value: BARCODE },
        ],
      },
    } as unknown as PassJson;
    const pass = {
      id: 'pass-1',
      orgId: 'org-1',
      templateId: template.id,
      templateVersion: template.version,
      serial: SERIAL,
      authToken: AUTH,
      downloadToken: DOWNLOAD,
      scanCode: SCAN_CODE,
      webServiceUrl: 'https://wallet.test/private-service',
      holderEmail: EMAIL,
      displayTitle: 'Ada North',
      displaySubtitle: null,
      externalId: 'MEMBER-983',
      createdAt: NOW - 1000,
      version: 1,
      status: 'active',
      mode: 'live',
      personalization: {
        memberName: 'Ada North',
        seat: 'C12',
        tier: 'Gold',
        points: 7,
        profile: {
          publicLabel: 'Atrium access',
          managerHint: MANAGER,
          internalNote: NESTED,
          nestedContact: 'nested@example.test',
        },
        privateNotes: SECRET,
        hiddenCount: HIDDEN_COUNT,
        contact: EMAIL,
        callback: PHONE,
        ticketNumber: BARCODE,
        undeclaredValue: 'undeclared sensitive value',
      },
    };
    return {
      pass,
      passJson,
      template,
      activeVersion: template.version,
      credentialKeysetCommitment: keysetCommitment,
      scan: scanOf(template.manifest),
      ref: { name: template.manifest.name, style: 'generic' },
    } as unknown as Found;
  }

  function inputOf(found: Found, role: ScanRole): BuildDisplayInput {
    return {
      actor: actorOf(role),
      pass: { id: found.pass.id, title: found.pass.displayTitle ?? '' },
      screen: 'ok',
      template: found,
    };
  }

  return { actorOf, fixture, inputOf, otherKeysetCommitment: () => otherKeysetCommitment };
}
