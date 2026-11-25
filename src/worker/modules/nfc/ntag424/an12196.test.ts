import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../sun.ts';
import { changeKey } from './change-key.ts';
import { crc32Nk } from './crc32.ts';
import { authFinish, authFirstApdu, authPart2, deriveSessionKeys, type Ev2Session } from './ev2.ts';
import { changeFileSettings, sdmFileSettings, writeData } from './file-settings.ts';
import { checkBare, checkResponse, getFileSettings, messageIv } from './secure-messaging.ts';

// NXP AN12196 rev 2.0 (4 March 2025), sections 4.3 and 5.6 to 5.16: every value below is copied from its tables.
const h = (hex: string) => hexToBytes(hex.replaceAll(' ', '')) as Uint8Array;
const hex = bytesToHex;
const ZERO = new Uint8Array(16);
const session = (enc: string, mac: string, ti: string, ctr: number): Ev2Session => ({
  keyNo: 0,
  ti: h(ti),
  encKey: h(enc),
  macKey: h(mac),
  ctr,
  dead: false,
});

describe('AuthenticateEV2First: Table 14 (key 0) and Table 19 (key 3), both zero keys', () => {
  it('Table 14: part 1 and 2 APDUs, session keys and TI', async () => {
    expect(hex(authFirstApdu(0))).toBe('9071000002000000');
    const rndA = h('13C5DB8A5930439FC3DEF9A4C675360F');
    const p2 = await authPart2(ZERO, h('A04C124213C186F22399D33AC2A30215'), rndA);
    expect(hex(p2.rndB)).toBe('b9e2fc789b64bf237cccaa20ec7e6e48');
    expect(hex(p2.apdu)).toBe(
      '90af00002035c3e05a752e0144bac0de51c1f22c56b34408a23d8aea266cab947ea8e0118d00',
    );
    const s = await authFinish(
      ZERO,
      0,
      rndA,
      p2.rndB,
      h('3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F08120663'),
    );
    expect(hex(s.ti)).toBe('9d00c4df');
    expect(hex(s.encKey)).toBe('1309c877509e5a215007ff0ed19ca564');
    expect(hex(s.macKey)).toBe('4c6626f5e72ea694202139295c7a7fc7');
    expect(s.ctr).toBe(0);
  });

  it('Table 19: key 3', async () => {
    expect(hex(authFirstApdu(3))).toBe('9071000002030000');
    const rndA = h('B98F4C50CF1C2E084FD150E33992B048');
    const p2 = await authPart2(ZERO, h('B875CEB0E66A6C5CD00898DC371F92D1'), rndA);
    expect(hex(p2.apdu)).toBe(
      '90af000020ff0306e47dfbc50087c4d8a78e88e62de1e8be457aa477c707e2f0874916a8b100',
    );
    const s = await authFinish(
      ZERO,
      3,
      rndA,
      p2.rndB,
      h('0CC9A8094A8EEA683ECAAC5C7BF20584206D0608D477110FC6B3D5D3F65C3A6A'),
    );
    expect(hex(s.ti)).toBe('7614281a');
    expect(hex(s.encKey)).toBe('7a93d6571e4b180fca6ac90c9a7488d4');
    expect(hex(s.macKey)).toBe('fc4af159b62e549b5812394cab1918cc');
  });

  it('Table 23: session keys of an EV2NonFirst-shaped exchange', async () => {
    const k = await deriveSessionKeys(
      ZERO,
      h('60BE759EDA560250AC57CDDC11743CF6'),
      h('6924E8D09722659A2E7DEC68E66312B8'),
    );
    expect(hex(k.encKey)).toBe('4cf3cb41a22583a61e89b158d252fc53');
    expect(hex(k.macKey)).toBe('5529860b2fc5fb6154b7f28361d30bf9');
  });

  it('refuses a tag that does not echo RndA', async () => {
    const rndA = h('13C5DB8A5930439FC3DEF9A4C675360F');
    const wrong = h('3FA64DB5446D1F34CD6EA311167F5E4985B89690C04A05F17FA7AB2F08120663');
    await expect(authFinish(ZERO, 0, h('00'.repeat(16)), rndA, wrong)).rejects.toMatchObject({
      code: 'NTAG_AUTH_FAILED',
    });
  });
});

describe('CommMode.MAC: Table 7, GetFileSettings', () => {
  const s = () => session('00'.repeat(16), '8248134A386E86EB7FAF54A52E536CB6', '7A21085E', 0);
  it('builds the command and accepts the response MAC', async () => {
    const sess = s();
    const { apdu, sent } = await getFileSettings(sess, 2);
    expect(hex(apdu)).toBe('90f5000009026597a457c8cd442c00');
    expect(sess.ctr).toBe(1);
    const data = '0040EEEE000100D1FE001F00004400004400002000006A0000';
    const out = await checkResponse(sess, sent, h(`${data}2A474282E7A479869100`));
    expect(hex(out)).toBe(data.toLowerCase());
  });
  it('refuses a flipped MAC bit, a wrong counter and a bad status', async () => {
    const sess = s();
    const { sent } = await getFileSettings(sess, 2);
    const data = '0040EEEE000100D1FE001F00004400004400002000006A0000';
    await expect(checkResponse(sess, sent, h(`${data}2A474282E7A479879100`))).rejects.toMatchObject(
      {
        code: 'NTAG_MAC_INVALID',
      },
    );
    await expect(
      checkResponse(sess, { ctr: 1 }, h(`${data}2A474282E7A479869100`)),
    ).rejects.toMatchObject({ code: 'NTAG_MAC_INVALID' });
    await expect(checkResponse(sess, sent, h('911e'))).rejects.toMatchObject({
      code: 'NTAG_COMMAND_FAILED',
    });
  });
});

describe('CommMode.Full', () => {
  const A = () =>
    session('1309C877509E5A215007FF0ED19CA564', '4C6626F5E72EA694202139295C7A7FC7', '9D00C4DF', 0);

  it('IVc of Table 17: E(SesAuthENC, A55A || TI || CmdCtr || 0)', async () => {
    expect(hex(await messageIv(A(), [0xa5, 0x5a], 0))).toBe('d2cb7277a17841a06654a48188c1f8f5');
    expect(hex(await messageIv(A(), [0xa5, 0x5a], 1))).toBe('3e27082ab2acc1ef55c57547934e9962');
  });

  it('Table 17: WriteData of the NDEF file, 128 bytes, one frame of 159', async () => {
    const text = `choose.url.com/ntag424?e=${'0'.repeat(32)}&c=${'0'.repeat(16)}`;
    const record = new Uint8Array([
      0xd1,
      0x01,
      0x4d,
      0x55,
      0x04,
      ...new TextEncoder().encode(text),
    ]);
    const file = new Uint8Array(128);
    file.set([0x00, 0x51, ...record]);
    const sess = A();
    const { apdu, sent } = await writeData(sess, 2, 0, file, 'full');
    expect(hex(apdu)).toBe(
      '908d00009f02000000800000421c73a27d827658af481fdff20a5025b559d0e3aa21e58d347f343cffc768bfe596c706bc00f2176781d4b0242642a0ff5a42c461aaf894d9a1284b8c76bcfa658acd40555d362e08db15cf421b51283f9064bcbe20e96cae545b407c9d651a3315b27373772e5da2367d2064ae054af996c6f1f669170fa88ce8c4e3a4a7bbbef0fd971ff532c3a802af745660f2b4d1d9a8499661ebf300',
    );
    expect(await checkResponse(sess, sent, h('FC222E5F7A5424529100'))).toHaveLength(0);
  });

  it('Table 18: ChangeFileSettings with the SDM payload, rights 00E0 and SDMAccessRights F121', async () => {
    const data = sdmFileSettings(
      { piccOffset: 0x20, macOffset: 0x43 },
      { meta: 2, file: 1, ctr: 1 },
    );
    expect(hex(data)).toBe('4000e0c1f121200000430000430000');
    const sess = A();
    sess.ctr = 1;
    const { apdu, sent } = await changeFileSettings(sess, 2, data);
    expect(hex(apdu)).toBe('905f0000190261b6d97903566e84c3ae5274467e89ead799b7c1a0ef7a0400');
    expect(await checkResponse(sess, sent, h('57BFF87B1241E93D9100'))).toHaveLength(0);
  });

  it('Table 24: WriteData in Plain mode builds a bare frame and still moves the counter', async () => {
    const sess = A();
    const data = h(`FF0506E10500808283${'00'.repeat(9)}`);
    const { apdu, sent } = await writeData(sess, 1, 0x0e, data);
    expect(hex(apdu)).toBe(`908d000019010e0000120000ff0506e10500808283${'00'.repeat(9)}00`);
    expect(sess.ctr).toBe(1);
    expect(checkBare(sess, h('9100')).sw).toBe(0x9100);
    expect(sent.ctr).toBe(0);
  });

  it('Table 21: WriteData to file 03 under the key 3 session', async () => {
    const sess = session(
      '7A93D6571E4B180FCA6AC90C9A7488D4',
      'FC4AF159B62E549B5812394CAB1918CC',
      '7614281A',
      0,
    );
    const { apdu, sent } = await writeData(sess, 3, 0, h('0102030405060708090A'), 'full');
    expect(hex(apdu)).toBe(
      '908d00001f030000000a00006b5e6804909962fc4e3ff5522cf0f8436c0c53315b9c73aa00',
    );
    expect(await checkResponse(sess, sent, h('C26D236E4A7C046D9100'))).toHaveLength(0);
  });
});

describe('ChangeKey: Tables 25 and 26', () => {
  const enc = '4CF3CB41A22583A61E89B158D252FC53';
  const mac = '5529860B2FC5FB6154B7F28361D30BF9';

  it('CRC32 of the new key is 789DFADC', () => {
    expect(hex(crc32Nk(h('F3847D627727ED3BC9C4CC050489B966')))).toBe('789dfadc');
  });

  it('Table 25: key 2 changed while authenticated with key 0 (old xor new, version, CRC32)', async () => {
    const sess = session(enc, mac, '7614281A', 2);
    const r = await changeKey(sess, {
      keyNo: 2,
      newKey: h('F3847D627727ED3BC9C4CC050489B966'),
      oldKey: ZERO,
      version: 1,
    });
    expect(r.endsSession).toBe(false);
    expect(hex(r.apdu)).toBe(
      '90c4000029022cf362b7bf4311ff3be1daa295e8c68de09050560d19b9e16c2393ae9cd1fac75d0ce20bcd1d06e600',
    );
    expect(await checkResponse(sess, r.sent, h('203BB55D1089D5879100'))).toHaveLength(0);
  });

  it('Table 26: key 0 changed while authenticated with key 0 (new, version, no CRC)', async () => {
    const sess = session(enc, mac, '7614281A', 3);
    const r = await changeKey(sess, {
      keyNo: 0,
      newKey: h('5004BF991F408672B1EF00F08F9E8647'),
      version: 1,
    });
    expect(r.endsSession).toBe(true);
    expect(hex(r.apdu)).toBe(
      '90c400002900c0eb4deefeddf0b513a03a95a75491818580503190d4d05053ff75668a01d6fda6610234bded643200',
    );
    expect(checkBare(sess, h('9100')).sw).toBe(0x9100);
  });

  it('refuses a version of 0, a wrong key length, and another key without its old value', async () => {
    const sess = session(enc, mac, '7614281A', 3);
    await expect(changeKey(sess, { keyNo: 0, newKey: ZERO, version: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      changeKey(sess, { keyNo: 0, newKey: new Uint8Array(15), version: 1 }),
    ).rejects.toThrow(RangeError);
    await expect(changeKey(sess, { keyNo: 1, newKey: ZERO, version: 1 })).rejects.toMatchObject({
      code: 'NTAG_UNSUPPORTED',
    });
    expect(sess.ctr).toBe(3);
  });
});
