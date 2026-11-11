import {
  installVersion,
  persistCardProjection,
  pinFixtureVersion,
  walletFixture,
} from './repo-resolve-test-fixtures.ts';
import { CHECK_IN, kit } from './resolve-test-fixtures.ts';

export async function cardProjectionFixture() {
  const templateId = await kit.scanTemplate('Private projection', {
    actions: [
      CHECK_IN,
      { id: 'notes', label: 'Notes', kind: 'set', input: 'privateNote' },
      { id: 'tier', label: 'Tier', kind: 'set', input: 'tier' },
      { id: 'lounge', label: 'Lounge', kind: 'set', input: 'lounge' },
      { id: 'balance', label: 'Balance', kind: 'take', input: 'balance', amount: 1 },
      { id: 'copy', label: 'Copy', kind: 'set', input: 'copy' },
    ],
  });
  const pass = await kit.scanPass(templateId, {}, { holderEmail: 'private-holder@example.test' });
  const base = await kit.registry.resolve(templateId);
  const template = {
    ...base,
    manifest: structuredClone(base.manifest),
    passJson: structuredClone(base.passJson),
  };
  const hidden = 'STAFF-ONLY-NOTE-84';
  const nestedHidden = 'NESTED-PRIVATE-86';
  const hiddenDefault = 'PRIVATE-DEFAULT-963';
  const password = 'Cobalt&Pearl<8>';
  const email = 'private-holder@example.test';
  const untypedEmail = 'reception@elsewhere.test';
  const telephone = '+44 7911 123456';
  const barcode = 'WALLET-PAYLOAD-8429';
  template.manifest.inputs = {
    type: 'object',
    properties: {
      memberName: { type: 'string' },
      tier: { type: 'string', 'x-scan': 'desk' },
      lounge: { type: 'string', 'x-scan': 'manager' },
      balance: { type: 'integer' },
      entrance: { type: 'string', default: 'North entrance' },
      privateDefault: { type: 'string', 'x-scan': 'hidden', default: hiddenDefault },
      copiedDefault: { type: 'string', default: hiddenDefault },
      privateNote: { type: 'string', 'x-scan': 'hidden' },
      wifiPassword: { type: 'string', 'x-scan': 'door' },
      callback: { type: 'string', 'x-widget': 'tel' },
      contact: { type: 'string', format: 'email' },
      ticketNumber: { type: 'string' },
      copy: { type: 'string' },
      codeCopy: { type: 'string' },
      tokenCopy: { type: 'string' },
      encodedCopy: { type: 'string' },
      notice: { type: 'string' },
      profile: {
        type: 'object',
        properties: {
          publicLabel: { type: 'string' },
          managerHint: { type: 'string', 'x-scan': 'manager' },
          insideNote: { type: 'string', 'x-scan': 'hidden' },
        },
      },
    },
  };
  if (!template.manifest.scan) throw new Error('Missing scan configuration');
  template.manifest.scan.flags = [
    { input: 'balance', label: 'Balance notice' },
    { input: 'tier', label: 'Tier notice' },
    { input: 'privateNote', label: 'Restricted notice' },
    { input: 'balance', label: password },
  ];
  template.manifest.display = { title: '{{memberName}}', subtitle: '{{lounge}}' };
  template.manifest.bindings = [
    { to: { field: 'name' }, value: '{{memberName}}' },
    { to: { field: 'tier' }, value: '{{tier}}' },
    { to: { field: 'lounge' }, value: '{{lounge}}' },
    { to: { field: 'entrance' }, value: '{{entrance}}' },
    { to: { field: 'default_copy' }, value: '{{copiedDefault}}' },
    { to: { field: 'public_nested' }, value: '{{profile.publicLabel}}' },
    { to: { field: 'manager_nested' }, value: '{{profile.managerHint}}' },
    { to: { field: 'private_nested' }, value: '{{profile.insideNote}}' },
    { to: { field: 'notes_field' }, value: '{{privateNote}}' },
    { to: { field: 'password_field' }, value: '{{wifiPassword}}' },
    { to: { field: 'email_field' }, value: '{{contact}}' },
    { to: { field: 'phone_field' }, value: '{{callback}}' },
    { to: { field: 'copy_field' }, value: '{{copy}}' },
    { to: { field: 'code_copy' }, value: '{{codeCopy}}' },
    { to: { field: 'token_copy' }, value: '{{tokenCopy}}' },
    { to: { field: 'encoded_copy' }, value: '{{encodedCopy}}' },
    { to: { field: 'notice_field' }, value: '{{notice}}' },
    { to: { field: 'server_ref' }, value: '{{pass.scanCode}}' },
    { to: { field: 'label_field', prop: 'label' }, value: '{{privateNote}}' },
    {
      to: { field: 'conditional' },
      value: 'Name: {{memberName}}',
      when: { input: 'privateNote', eq: hidden },
    },
    { to: { barcode: 0, prop: 'message' }, value: '{{ticketNumber}}' },
    { to: { pointer: '/logoText' }, value: '{{lounge}}' },
  ];
  template.passJson.generic = {
    primaryFields: [{ key: 'name', label: 'Member', value: '' }],
    secondaryFields: [
      { key: 'tier', label: 'Tier', value: '', textAlignment: 'PKTextAlignmentRight' },
      { key: 'lounge', label: 'Lounge', value: '' },
      { key: 'public_nested', label: 'Area', value: '' },
      { key: 'manager_nested', label: 'Host', value: '' },
      { key: 'private_nested', label: 'Private', value: '' },
      { key: 'entrance', label: 'Entry', value: '' },
      { key: 'static', label: 'Membership', value: 'Member' },
    ],
    backFields: [
      { key: 'notes_field', value: '' },
      { key: 'password_field', value: '' },
      { key: 'email_field', value: '' },
      { key: 'phone_field', value: '' },
      { key: 'copy_field', value: '' },
      { key: 'code_copy', value: '' },
      { key: 'token_copy', value: '' },
      { key: 'encoded_copy', value: '' },
      { key: 'notice_field', value: '' },
      { key: 'default_copy', value: '' },
      { key: 'server_ref', value: '' },
      { key: 'label_field', label: '', value: 'A fixed value' },
      { key: 'conditional', value: '' },
      { key: 'unbound', value: 'Template text' },
    ],
  };
  template.passJson.backgroundColor = 'rgb(20, 30, 40)';
  const pinnedRelease = await installVersion(
    templateId,
    'v2',
    template.manifest,
    template.passJson,
    'scan-display-compatible',
  );
  await pinFixtureVersion(pass.id, 'v2', pinnedRelease.id);
  const snapshot = await walletFixture(pass.id, template.passJson);
  const values: Record<string, string> = {
    name: 'Ada Carter',
    tier: 'Silver desk tier',
    lounge: 'Roof manager lounge',
    public_nested: 'Public atrium',
    manager_nested: 'Manager balcony host',
    entrance: 'North entrance',
    private_nested: nestedHidden,
    notes_field: hidden,
    password_field: password,
    email_field: email,
    phone_field: telephone,
    copy_field: hidden,
    code_copy: barcode,
    token_copy: pass.authToken,
    encoded_copy: encodeURIComponent(password),
    notice_field: untypedEmail,
    default_copy: hiddenDefault,
    server_ref: pass.scanCode ?? '',
    conditional: 'Name: Ada Carter',
    unbound: 'UNAPPROVED-SNAPSHOT-DATA',
  };
  for (const fields of [
    snapshot.generic?.primaryFields,
    snapshot.generic?.secondaryFields,
    snapshot.generic?.backFields,
  ]) {
    for (const field of fields ?? []) {
      if (Object.hasOwn(values, field.key)) field.value = values[field.key] as string;
    }
  }
  const style = snapshot.generic;
  const primary = style?.primaryFields?.[0];
  if (!style || !primary) throw new Error('Missing primary wallet field');
  primary.attributedValue = pass.downloadToken;
  primary.privateMetadata = 'ARBITRARY-FIELD-METADATA';
  style.privateStyleMetadata = 'ARBITRARY-STYLE-METADATA';
  snapshot.logoText = 'Roof manager lounge';
  snapshot.barcodes = [{ format: 'PKBarcodeFormatQR', message: barcode, messageEncoding: 'utf-8' }];
  snapshot.nfc = { message: 'NFC-PAYLOAD-SECRET', encryptionPublicKey: 'public-key' };
  snapshot.authenticationToken = pass.authToken;
  snapshot.serialNumber = pass.serial;
  snapshot.webServiceURL = pass.webServiceUrl;
  snapshot.userInfo = { metadata: 'ARBITRARY-TOP-LEVEL-METADATA', download: pass.downloadToken };
  await persistCardProjection(
    pass.id,
    snapshot,
    {
      memberName: 'Ada Carter',
      tier: 'Silver desk tier',
      lounge: 'Roof manager lounge',
      balance: 17,
      privateNote: hidden,
      wifiPassword: password,
      callback: telephone,
      contact: email,
      ticketNumber: barcode,
      copy: hidden,
      codeCopy: barcode,
      tokenCopy: pass.authToken,
      encodedCopy: encodeURIComponent(password),
      notice: untypedEmail,
      profile: {
        publicLabel: 'Public atrium',
        managerHint: 'Manager balcony host',
        insideNote: nestedHidden,
      },
    },
    hidden,
    password,
  );
  return {
    templateId,
    pass,
    template,
    pinnedRelease,
    hidden,
    nestedHidden,
    hiddenDefault,
    password,
    email,
    untypedEmail,
    telephone,
    barcode,
  };
}
