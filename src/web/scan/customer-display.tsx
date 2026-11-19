import { useEffect, useState } from 'react';
import { z } from 'zod';
import { CustomerStage } from './customer-stage.tsx';
import { toneOfStatus } from './customer-tone.ts';
import { scanBrandStyle } from './platform/scan-branding.tsx';

const DisplayStatus = z.enum(['ready', 'checking', 'accepted', 'checkedOut', 'rejected', 'failed']);
const DisplayBranding = z.strictObject({
  name: z.string().trim().min(1).max(120),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
  logoSha: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
const DisplayMessage = z.strictObject({
  status: DisplayStatus,
  revision: z.number().int().nonnegative(),
  branding: DisplayBranding.nullable().optional(),
});
type NativeStatus = z.infer<typeof DisplayStatus>;
type NativeBranding = z.infer<typeof DisplayBranding> | null;
interface CustomerDisplayBridge {
  status: NativeStatus;
  revision: number;
  branding?: NativeBranding;
  onmessage: ((event: { data: string }) => void) | null;
}

declare global {
  interface Window {
    PassBookCustomerDisplay?: CustomerDisplayBridge;
  }
}

export function CustomerDisplayPage() {
  const [display, setDisplay] = useState<{
    status: NativeStatus;
    revision: number;
    branding: NativeBranding;
  }>({
    status: 'ready',
    revision: 0,
    branding: null,
  });
  useEffect(() => {
    const bridge = window.PassBookCustomerDisplay;
    if (!bridge) return;
    const receive = ({ data }: { data: string }) => {
      try {
        const parsed = DisplayMessage.safeParse(JSON.parse(data));
        if (parsed.success)
          setDisplay((current) => ({
            ...parsed.data,
            branding: parsed.data.branding === undefined ? current.branding : parsed.data.branding,
          }));
      } catch {
        // The accessory sends only this small status record.
      }
    };
    bridge.onmessage = receive;
    const initial = DisplayMessage.safeParse({
      status: bridge.status,
      revision: bridge.revision,
      branding: bridge.branding ?? null,
    });
    if (initial.success) setDisplay({ ...initial.data, branding: initial.data.branding ?? null });
    return () => {
      if (bridge.onmessage === receive) bridge.onmessage = null;
    };
  }, []);

  const brandName = display.branding?.name ?? 'PassBook';
  const logoUrl = display.branding?.logoSha
    ? `/api/v1/scan/branding/logo?v=${display.branding.logoSha}`
    : null;
  return (
    <CustomerStage
      tone={toneOfStatus(display.status)}
      replay={display.revision}
      brandName={brandName}
      logoUrl={logoUrl}
      style={scanBrandStyle({ accent: display.branding?.accent ?? null, logo: null })}
    />
  );
}
