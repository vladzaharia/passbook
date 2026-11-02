import { useEffect, useRef, useState } from 'react';

const created = new Map<string, { sent: boolean; first: boolean }>();
/** The wizard marks a pass it just created, so its page offers the next steps once. */
export const markCreated = (id: string, sent: boolean, first: boolean) =>
  void created.set(id, { sent, first });
/**
 * Once per created pass: whether to offer the next steps (created without sending) and whether
 * it was the org's first pass (a celebration).
 */
export function useCreated(id: string): { unsent: boolean; first: boolean; dismiss: () => void } {
  const [mark] = useState(() => created.get(id));
  const [show, setShow] = useState(mark?.sent === false);
  useEffect(() => {
    created.delete(id);
  }, [id]);
  return { unsent: show, first: mark?.first === true, dismiss: () => setShow(false) };
}

/**
 * Stage motion from data: mint when the version goes up on an active pass (or once on arrival
 * from the wizard), settle and stamp when it turns void. Browsing versions never mints.
 */
export function useStageMotion(version: number, status: string, mintedOnArrival: boolean) {
  const last = useRef({ version, status });
  const [mint, setMint] = useState(0);
  const [settle, setSettle] = useState(0);
  const [stamp, setStamp] = useState(false);
  useEffect(() => {
    if (mintedOnArrival) setMint((n) => n + 1);
  }, [mintedOnArrival]);
  useEffect(() => {
    const prev = last.current;
    if (status === 'voided' && prev.status !== 'voided') {
      setSettle((n) => n + 1);
      setStamp(true);
    } else if (status === 'active' && version > prev.version) {
      setMint((n) => n + 1);
      setStamp(false);
    }
    last.current = { version, status };
  }, [version, status]);
  return { mint, settle, stamp };
}
