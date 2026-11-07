import { scanId } from '../platform/id.ts';

let memory: string | undefined;
/** This is a browser label, never a credential. Platform sign-in still authorizes every use. */
export function scanDeviceKey() {
  if (memory) return memory;
  try {
    const saved = localStorage.getItem('passbook.scan.device');
    if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved)) {
      memory = saved;
      return memory;
    }
    memory = scanId();
    localStorage.setItem('passbook.scan.device', memory);
  } catch {
    memory ??= scanId();
  }
  return memory;
}
