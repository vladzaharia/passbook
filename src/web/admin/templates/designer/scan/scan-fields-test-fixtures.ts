export const manifest = {
  inputs: {
    properties: {
      tier: { type: 'string', enum: ['Standard', 'VIP'], 'x-scan': 'desk' },
      quantity: { type: 'integer', enum: [1, 2, 3] },
      email: { type: 'string', format: 'email', 'x-scan': 'door' },
      phoneNumber: { type: 'string', 'x-scan': 'door' },
      contactName: { type: 'string', 'x-scan': 'door' },
      scanCode: { type: 'string', 'x-scan': 'door' },
      barCode: { type: 'string', 'x-scan': 'door' },
      wifiPassword: { type: 'string', 'x-scan': 'door' },
      ticket: { type: 'string' },
    },
  },
  bindings: [
    { to: { barcode: '*', prop: 'message' }, value: '{{ticket}}' },
    { to: { field: 'member', prop: 'value' }, value: '{{quantity}}' },
    { to: { field: 'ticketfield', prop: 'value' }, value: '{{ticket}}' },
    { to: { field: 'level', prop: 'value' }, value: '{{tier}}' },
    { to: { field: 'privatefield', prop: 'value' }, value: '{{phoneNumber}}' },
  ],
  sample: { email: 'never@example.test', phoneNumber: 'PRIVATE_PHONE' },
  scan: {
    actions: [
      { id: 'credit', kind: 'add', input: 'quantity', label: 'Credit' },
      { id: 'secret', kind: 'set', input: 'phoneNumber', label: 'Private' },
    ],
  },
};

export const passJson = {
  barcodes: [{ message: 'PRIVATE_BARCODE' }],
  generic: {
    primaryFields: [
      { key: 'member', value: 'Ordinary' },
      { key: 'level', value: 'VIP' },
      { key: 'privatefield', value: 'PRIVATE_PHONE' },
      { key: 'reference', value: 'PRIVATE_BARCODE' },
    ],
  },
};
