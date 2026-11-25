import { describe, expect, it } from 'vitest';
import { INS, native, SW, splitResponse } from '../apdu.ts';
import { u24 } from '../bytes.ts';
import { changeFileSettings, writeData } from '../file-settings.ts';
import { sunTemplate } from '../sdm-layout.ts';
import { checkResponse, getFileSettings, macCommand } from '../secure-messaging.ts';
import { authenticate } from './program.ts';
import { Ntag424Sim } from './tag.ts';

const sendOf = (sim: Ntag424Sim) => (apdu: Uint8Array) => sim.transceive(apdu);
const sw = async (sim: Ntag424Sim, apdu: Uint8Array) =>
  splitResponse(await sim.transceive(apdu)).sw;

async function blankSession() {
  const sim = new Ntag424Sim();
  const session = await authenticate(sendOf(sim), 0, new Uint8Array(16));
  return { sim, session };
}

describe('communication modes follow the file, not the sender', () => {
  it('WriteData to file 02 is Plain: a Full-mode frame is a length error and ends the session', async () => {
    const { sim, session } = await blankSession();
    const { apdu } = await writeData(session, 2, 0, new Uint8Array([0, 3, 1, 2, 3]), 'full');
    expect(await sw(sim, apdu)).toBe(0x917e);
    expect(sim.tag.session).toBeNull();
    expect(sim.tag.files.get(2)?.data[1]).toBe(0);
  });

  it('a Plain WriteData to file 02 writes, and the counter moves so the next MAC still matches', async () => {
    const { sim, session } = await blankSession();
    const { apdu, sent } = await writeData(session, 2, 0, new Uint8Array([0, 3, 1, 2, 3]));
    const answer = await sim.transceive(apdu);
    expect(answer).toEqual(new Uint8Array([0x91, 0x00]));
    expect(sent.ctr).toBe(0);
    expect(sim.tag.session?.ctr).toBe(1);
    expect(sim.tag.files.get(2)?.data.slice(0, 5)).toEqual(new Uint8Array([0, 3, 1, 2, 3]));
    const next = await getFileSettings(session, 2);
    expect(await checkResponse(session, next.sent, await sim.transceive(next.apdu))).toHaveLength(
      7,
    );
  });

  it('a Plain WriteData to file 03, a Full-mode file, is refused', async () => {
    const sim = new Ntag424Sim();
    const session = await authenticate(sendOf(sim), 3, new Uint8Array(16));
    expect(await sw(sim, (await writeData(session, 3, 0, new Uint8Array([1]))).apdu)).toBe(0x917e);
  });

  it('a Plain frame wrongly shaped as MAC mode ends the session', async () => {
    const { sim, session } = await blankSession();
    const { apdu } = await macCommand(session, INS.getFileSettings, new Uint8Array([2]));
    // A MAC-mode GetFileSettings is right; the same bytes as ChangeFileSettings are not.
    const wrong = native(INS.changeFileSettings, apdu.slice(5, 5 + (apdu[4] as number)));
    expect(await sw(sim, wrong)).toBe(SW.integrity);
    expect(sim.tag.session).toBeNull();
  });

  it('any non-9100 answer ends the authenticated state', async () => {
    const { sim, session } = await blankSession();
    expect(await sw(sim, native(INS.getKeyVersion, new Uint8Array(9)))).toBe(SW.integrity);
    expect(sim.tag.session).toBeNull();
    expect(session.ctr).toBe(0);
  });

  it('the free read of file settings works without authentication, in plain', async () => {
    const sim = new Ntag424Sim();
    const answer = splitResponse(
      await sim.transceive(native(INS.getFileSettings, new Uint8Array([2]))),
    );
    expect(answer.sw).toBe(SW.ok);
    expect([...answer.data]).toEqual([0x00, 0x00, 0xe0, 0xee, 0x00, 0x01, 0x00]);
  });
});

describe('ChangeFileSettings parameter rules (datasheet Table 71)', () => {
  const rights = [0x40, 0x00, 0xe0];
  const offsets = [...u24(36), ...u24(71), ...u24(71)];
  const attempt = async (head: number[], tail = offsets) => {
    const { sim, session } = await blankSession();
    const { apdu } = await changeFileSettings(
      session,
      2,
      new Uint8Array([...rights, ...head, ...tail]),
    );
    return sw(sim, apdu);
  };

  it('accepts the layout this platform writes', async () => {
    expect(await attempt([0xc1, 0xff, 0x12])).toBe(SW.ok);
  });
  it('refuses a counter access right while the counter mirror is off', async () => {
    expect(await attempt([0x81, 0xf1, 0x12])).toBe(0x919e);
  });
  it('refuses a MetaRead right while neither the UID nor the counter mirrors', async () => {
    expect(await attempt([0x01, 0xff, 0x12])).toBe(0x919e);
  });
  it('refuses MetaRead F while the UID mirrors', async () => {
    expect(await attempt([0xc1, 0xff, 0xf2])).toBe(0x919e);
  });
  it('refuses a MAC that overlaps the PICCData', async () => {
    expect(await attempt([0xc1, 0xff, 0x12], [...u24(36), ...u24(50), ...u24(50)])).toBe(0x919e);
  });
  it('refuses a key that does not exist', async () => {
    expect(await attempt([0xc1, 0xff, 0x92])).toBe(0x919e);
  });
});

describe('guards in the builders', () => {
  it('stops at a spent counter and after a failed answer', async () => {
    const { sim, session } = await blankSession();
    const built = await getFileSettings(session, 2);
    await expect(
      checkResponse(session, built.sent, new Uint8Array([0x91, 0x1e])),
    ).rejects.toMatchObject({
      code: 'NTAG_COMMAND_FAILED',
    });
    expect(session.dead).toBe(true);
    await expect(getFileSettings(session, 2)).rejects.toMatchObject({
      code: 'NTAG_COMMAND_FAILED',
    });
    const spent = await authenticate(sendOf(sim), 0, new Uint8Array(16));
    spent.ctr = 0xffff;
    await expect(getFileSettings(spent, 2)).rejects.toMatchObject({ code: 'NTAG_COMMAND_FAILED' });
  });
  it('refuses an APDU body over 255 bytes and a Plain write over 248', async () => {
    expect(() => native(INS.writeData, new Uint8Array(256))).toThrow(RangeError);
    const s = {
      keyNo: 0,
      ti: new Uint8Array(4),
      encKey: new Uint8Array(16),
      macKey: new Uint8Array(16),
      ctr: 0,
      dead: false,
    };
    await expect(writeData(s, 2, 0, new Uint8Array(249))).rejects.toThrow(RangeError);
    expect((await writeData(s, 2, 0, new Uint8Array(248))).apdu).toHaveLength(5 + 7 + 248 + 1);
  });
  it('refuses a URL that does not fit one write', () => {
    expect(() => sunTemplate('passbook.mobile', 'x'.repeat(220))).toThrow();
    expect(sunTemplate('passbook.mobile', 'k0000001').file.length <= 248).toBe(true);
  });
});
