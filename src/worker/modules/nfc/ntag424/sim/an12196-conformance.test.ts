import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../../sun.ts';
import { Ntag424Sim } from './tag.ts';

// NXP AN12196 rev 2.0, one literal exchange after another against the simulator, seeded with the application
// note's RndB and TI. The simulator decides the communication mode itself (file 02 is preset to FileOption 43,
// as Table 17 needs a Full-mode file); each C-APDU must produce the R-APDU the note prints.
const h = (hex: string) => hexToBytes(hex) as Uint8Array;

const NDEF_FILE_APDU =
  '908D00009F02000000800000421C73A27D827658AF481FDFF20A5025B559D0E3AA21E58D347F343CFFC768BFE596C706BC00F2176781D4B0242642A0FF5A42C461AAF894D9A1284B8C76BCFA658ACD40555D362E08DB15CF421B51283F9064BCBE20E96CAE545B407C9D651A3315B27373772E5DA2367D2064AE054AF996C6F1F669170FA88CE8C4E3A4A7BBBEF0FD971FF532C3A802AF745660F2B4D1D9A8499661EBF300';

const STEPS: [string, string, string][] = [
  ['T14 auth 1 (key 0)', '9071000002000000', 'A04C124213C186F22399D33AC2A3021591AF'],
  [
    'T14 auth 2',
    '90AF00002035C3E05A752E0144BAC0DE51C1F22C56B34408A23D8AEA266CAB947EA8E0118D00',
    '3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F081206639100',
  ],
  ['T17 WriteData, Full, file 02', NDEF_FILE_APDU, 'FC222E5F7A5424529100'],
  [
    'T18 ChangeFileSettings, SDM',
    '905F0000190261B6D97903566E84C3AE5274467E89EAD799B7C1A0EF7A0400',
    '57BFF87B1241E93D9100',
  ],
  ['T19 auth 1 (key 3)', '9071000002030000', 'B875CEB0E66A6C5CD00898DC371F92D191AF'],
  [
    'T19 auth 2',
    '90AF000020FF0306E47DFBC50087C4D8A78E88E62DE1E8BE457AA477C707E2F0874916A8B100',
    '0CC9A8094A8EEA683ECAAC5C7BF20584206D0608D477110FC6B3D5D3F65C3A6A9100',
  ],
  [
    'T21 WriteData, Full, file 03',
    '908D00001F030000000A00006B5E6804909962FC4E3FF5522CF0F8436C0C53315B9C73AA00',
    'C26D236E4A7C046D9100',
  ],
  ['T22 select the NDEF application', '00A4040C07D276000085010100', '9000'],
  ['T23 EV2NonFirst part 1 (key 0)', '90770000010000', 'A6A2B3C572D06C097BB8DB70463E22DC91AF'],
  [
    'T23 part 2',
    '90AF000020BE7D45753F2CAB85F34BC60CE58B940763FE969658A532DF6D95EA2773F6E99100',
    'B888349C24B315EAB5B589E279C8263E9100',
  ],
  [
    'T24 WriteData, Plain, file 01 (the counter still moves)',
    `908D000019010E0000120000FF0506E10500808283${'00'.repeat(9)}00`,
    '9100',
  ],
  [
    'T25 ChangeKey 2 from key 0',
    '90C4000029022CF362B7BF4311FF3BE1DAA295E8C68DE09050560D19B9E16C2393AE9CD1FAC75D0CE20BCD1D06E600',
    '203BB55D1089D5879100',
  ],
  [
    'T26 ChangeKey 0 from key 0',
    '90C400002900C0EB4DEEFEDDF0B513A03A95A75491818580503190D4D05053FF75668A01D6FDA6610234BDED643200',
    '9100',
  ],
];

describe('the simulator answers AN12196 literally', () => {
  it('runs Tables 14 to 26 in the application note order', async () => {
    const queue = [
      h('B9E2FC789B64BF237CCCAA20EC7E6E48'),
      h('9D00C4DF'),
      h('91517975190DCEA6104948EFA3085C1B'),
      h('7614281A'),
      h('6924E8D09722659A2E7DEC68E66312B8'),
    ];
    const sim = new Ntag424Sim({ random: () => queue.shift() as Uint8Array, isoInSession: 'keep' });
    const ndef = sim.tag.files.get(2);
    if (!ndef) throw new Error('no file 02');
    Object.assign(ndef, { option: 0x43, rw: 0x0, change: 0x0, read: 0xe, write: 0x0 });
    for (const [name, apdu, answer] of STEPS) {
      const got = bytesToHex(await sim.transceive(h(apdu)));
      expect(`${name}: ${got}`).toBe(`${name}: ${answer.toLowerCase()}`);
    }
    expect(queue).toHaveLength(0);
    expect(bytesToHex(sim.tag.keys[2] as Uint8Array)).toBe('f3847d627727ed3bc9c4cc050489b966');
    expect(bytesToHex(sim.tag.keys[0] as Uint8Array)).toBe('5004bf991f408672b1ef00f08f9e8647');
    expect(sim.tag.versions).toEqual([1, 0, 1, 0, 0]);
    expect(sim.tag.session).toBeNull();
    expect(ndef.sdm).toMatchObject({
      piccOffset: 0x20,
      macOffset: 0x43,
      metaKey: 2,
      fileKey: 1,
      ctrKey: 1,
    });
  });
});
