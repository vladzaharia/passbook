/**
 * Serial scanners (Web Serial, Chrome): a scanner in serial mode sends each code as a line. Ports
 * granted before reopen on their own; a new one needs Connect, a tap that opens the browser's picker.
 */
export interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}
export interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(): Promise<SerialPortLike>;
  addEventListener?(type: 'connect', listener: () => void): void;
  removeEventListener?(type: 'connect', listener: () => void): void;
}

/** The bus's own cap: a port that never ends a line (a wrong baud) cannot grow without bound. */
export const SERIAL_LINE_MAX = 2048;

/** The common default for serial barcode scanners. */
export const SERIAL_BAUD = 9600;

export function linesOf(buffer: string): { codes: string[]; rest: string } {
  const parts = buffer.split(/\r\n|\r|\n/);
  const rest = parts.pop() ?? '';
  return { codes: parts.map((p) => p.trim()).filter(Boolean), rest };
}

export function createSerialScanners(
  serial: SerialLike | undefined,
  emit: (code: string) => void,
  changed: () => void,
) {
  const readers = new Map<SerialPortLike, ReadableStreamDefaultReader<Uint8Array>>();
  let stopped = false;
  const read = async (port: SerialPortLike) => {
    if (stopped || readers.has(port)) return;
    try {
      if (!port.readable) await port.open({ baudRate: SERIAL_BAUD });
    } catch {
      // Another tab or app holds the port: it stays listed, not read.
      changed();
      return;
    }
    if (!port.readable || stopped) return;
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = port.readable.getReader();
    } catch {
      // Locked by another reader (a second tab): it stays listed, not read.
      return;
    }
    const text = new TextDecoder();
    readers.set(port, reader);
    changed();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const next = linesOf(buffer + text.decode(value, { stream: true }));
        buffer = next.rest.length > SERIAL_LINE_MAX ? '' : next.rest;
        for (const code of next.codes) emit(code);
      }
    } catch {
      // Unplugged mid-read: the port closes below and the list says so.
    } finally {
      readers.delete(port);
      reader.releaseLock();
      await port.close().catch(() => undefined);
      if (!stopped) changed();
    }
  };
  const resume = async () => {
    if (!serial || stopped) return;
    for (const port of await serial.getPorts().catch(() => [])) void read(port);
  };
  // A scanner plugged back in: read it again without a reload.
  const onConnect = () => void resume();
  serial?.addEventListener?.('connect', onConnect);
  return {
    supported: serial !== undefined,
    /** Reopens ports granted before. Never prompts. */
    resume,
    /** From a tap only: the browser's port picker. False when the person cancels. */
    async connect(): Promise<boolean> {
      if (!serial) return false;
      try {
        void read(await serial.requestPort());
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      stopped = true;
      serial?.removeEventListener?.('connect', onConnect);
      for (const reader of readers.values()) void reader.cancel().catch(() => undefined);
    },
  };
}
