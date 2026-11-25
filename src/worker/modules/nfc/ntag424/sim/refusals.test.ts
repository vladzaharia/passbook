import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../../sun.ts';
import { INS, native, SW, selectNdefApp, splitResponse } from '../apdu.ts';
import { changeKey } from '../change-key.ts';
import { authFirstApdu, authPart2 } from '../ev2.ts';
import {
  changeFileSettings,
  FACTORY_NDEF_SETTINGS,
  sdmFileSettings,
  writeData,
} from '../file-settings.ts';
import { checkResponse, getKeyVersion } from '../secure-messaging.ts';
import { testPlan, ZERO16 } from './fixtures.ts';
import { authenticate, programTag, readUrl } from './program.ts';
import { RelayServer } from './relay-server.ts';
import { Ntag424Sim } from './tag.ts';

const sendOf = (sim: Ntag424Sim) => (apdu: Uint8Array) => sim.transceive(apdu);
const sw = async (sim: Ntag424Sim, apdu: Uint8Array) =>
  splitResponse(await sim.transceive(apdu)).sw;
const plan = testPlan();

async function programmed() {
  const sim = new Ntag424Sim();
  await programTag(sendOf(sim), new RelayServer(plan));
  sim.reattach();
  return sim;
}

describe('authentication refusals', () => {
  it('a wrong key is refused and leaves no session', async () => {
    const sim = await programmed();
    await expect(authenticate(sendOf(sim), 0, plan.keys[3] as Uint8Array)).rejects.toMatchObject({
      code: 'NTAG_AUTH_FAILED',
    });
    expect(sim.tag.session).toBeNull();
    const session = await authenticate(sendOf(sim), 0, plan.keys[0] as Uint8Array);
    expect(session.ctr).toBe(0);
  });

  it('a recorded part 2 does not authenticate a new challenge', async () => {
    const sim = await programmed();
    const recorded: Uint8Array[] = [];
    const record = async (apdu: Uint8Array) => {
      recorded.push(apdu);
      return sim.transceive(apdu);
    };
    await authenticate(record, 0, plan.keys[0] as Uint8Array);
    sim.reattach();
    expect(await sw(sim, authFirstApdu(0))).toBe(SW.more);
    expect(await sw(sim, recorded[1] as Uint8Array)).toBe(SW.authError);
    expect(sim.tag.session).toBeNull();
  });

  it('part 2 without a part 1 is aborted', async () => {
    const sim = new Ntag424Sim();
    const bogus = (await authPart2(ZERO16, new Uint8Array(16), new Uint8Array(16))).apdu;
    expect(await sw(sim, bogus)).toBe(0x91ca);
  });

  it('a command without authentication is refused', async () => {
    const sim = await programmed();
    expect(await sw(sim, native(INS.getKeyVersion, new Uint8Array(9)))).toBe(SW.authError);
  });
});

describe('message refusals', () => {
  it('a command with a flipped MAC bit ends the session and changes nothing', async () => {
    const sim = await programmed();
    const send = sendOf(sim);
    const session = await authenticate(send, 0, plan.keys[0] as Uint8Array);
    const { apdu } = await changeKey(session, {
      keyNo: 1,
      newKey: ZERO16,
      oldKey: plan.keys[1],
      version: 9,
    });
    const bad = apdu.slice();
    bad[bad.length - 2] = (bad[bad.length - 2] as number) ^ 0x01;
    expect(await sw(sim, bad)).toBe(SW.integrity);
    expect(sim.tag.session).toBeNull();
    expect(bytesToHex(sim.tag.keys[1] as Uint8Array)).toBe(bytesToHex(plan.keys[1] as Uint8Array));
    expect(sim.tag.versions[1]).toBe(3);
  });

  it('a recorded command does not run in a new session', async () => {
    const sim = await programmed();
    const send = sendOf(sim);
    const first = await authenticate(send, 3, plan.keys[3] as Uint8Array);
    const { apdu } = await writeData(first, 3, 0, new Uint8Array([1, 2, 3]), 'full');
    sim.reattach();
    await authenticate(send, 3, plan.keys[3] as Uint8Array);
    expect(await sw(sim, apdu)).toBe(SW.integrity);
    expect(sim.tag.files.get(3)?.data[0]).toBe(0);
  });

  it('a ChangeKey built from the wrong old key fails its CRC and the key stays', async () => {
    const sim = await programmed();
    const send = sendOf(sim);
    const session = await authenticate(send, 0, plan.keys[0] as Uint8Array);
    const { apdu } = await changeKey(session, {
      keyNo: 2,
      newKey: plan.keys[4] as Uint8Array,
      oldKey: ZERO16,
      version: 9,
    });
    expect(await sw(sim, apdu)).toBe(SW.integrity);
    expect(bytesToHex(sim.tag.keys[2] as Uint8Array)).toBe(bytesToHex(plan.keys[2] as Uint8Array));
    expect(sim.tag.versions[2]).toBe(3);
  });

  it('a tag answer with a bad MAC is refused by the reader', async () => {
    const sim = await programmed();
    const send = sendOf(sim);
    const session = await authenticate(send, 0, plan.keys[0] as Uint8Array);
    const { apdu, sent } = await getKeyVersion(session, 1);
    const answer = await send(apdu);
    const bad = answer.slice();
    bad[2] = (bad[2] as number) ^ 0x80;
    await expect(checkResponse(session, sent, bad)).rejects.toMatchObject({
      code: 'NTAG_MAC_INVALID',
    });
    expect((await checkResponse(session, sent, answer))[0]).toBe(3);
  });
});

describe('access rights after programming', () => {
  it('only key 0 changes the file settings; another key is refused', async () => {
    const sim = await programmed();
    const send = sendOf(sim);
    let k1 = await authenticate(send, 1, plan.keys[1] as Uint8Array);
    const data = sdmFileSettings({ piccOffset: 37, macOffset: 82 });
    expect(await sw(sim, (await changeFileSettings(k1, 2, data)).apdu)).toBe(0x919d);
    // The refusal ended the session on the tag.
    expect(sim.tag.session).toBeNull();
    k1 = await authenticate(send, 1, plan.keys[1] as Uint8Array);
    expect(
      await sw(
        sim,
        (await changeKey(k1, { keyNo: 2, newKey: ZERO16, oldKey: plan.keys[2], version: 4 })).apdu,
      ),
    ).toBe(0x919d);
  });

  it('key 0 can turn SDM off again: the URL then reads with its placeholders', async () => {
    const sim = await programmed();
    const send = sendOf(sim);
    const session = await authenticate(send, 0, plan.keys[0] as Uint8Array);
    const { apdu, sent } = await changeFileSettings(session, 2, FACTORY_NDEF_SETTINGS);
    await checkResponse(session, sent, await send(apdu));
    expect(sim.tag.files.get(2)?.sdm).toBeNull();
    await send(selectNdefApp());
    expect(await readUrl(send)).toBe(
      `https://passbook.mobile/t/${plan.slug}?p=${'0'.repeat(32)}&m=${'0'.repeat(16)}`,
    );
  });

  it('a plain UpdateBinary no longer writes the URL', async () => {
    const sim = await programmed();
    await sim.transceive(
      new Uint8Array([0x00, 0xa4, 0x04, 0x0c, 7, 0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0]),
    );
    await sim.transceive(new Uint8Array([0x00, 0xa4, 0x00, 0x0c, 2, 0xe1, 0x04, 0]));
    expect(await sw(sim, new Uint8Array([0x00, 0xd6, 0, 0, 1, 0x41]))).toBe(0x6982);
  });
});
