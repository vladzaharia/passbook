import { useEffect, useState } from 'react';
import { z } from 'zod';
import { CustomerBuddy, type CustomerBuddyStatus } from './live/customer-buddy.tsx';
import { ScanOrgLogo, scanBrandStyle } from './platform/scan-branding.tsx';
import './customer-display.css';

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

function buddyStatus(status: NativeStatus): CustomerBuddyStatus {
  if (status === 'accepted') return 'accepted';
  if (status === 'checkedOut') return 'checkedOut';
  if (status === 'checking') return 'checking';
  if (status === 'rejected' || status === 'failed') return 'needsStaff';
  return 'ready';
}

function message(status: NativeStatus) {
  switch (status) {
    case 'checking':
      return { eyebrow: 'Checking', title: 'Checking pass', hint: 'Please wait.' };
    case 'accepted':
      return { eyebrow: 'Entry recorded', title: "You're checked in", hint: '' };
    case 'checkedOut':
      return { eyebrow: 'Exit recorded', title: "You're checked out", hint: '' };
    case 'rejected':
    case 'failed':
      return { eyebrow: 'Staff assistance', title: 'Please see staff', hint: '' };
    default:
      return { eyebrow: 'Ready to scan', title: 'Ready', hint: 'Hold up your pass.' };
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

  const copy = message(display.status);
  const brandName = display.branding?.name ?? 'PassBook';
  const logoUrl = display.branding?.logoSha
    ? `/api/v1/scan/branding/logo?v=${display.branding.logoSha}`
    : null;
  const brandStyle = scanBrandStyle({
    accent: display.branding?.accent ?? null,
    logo: null,
  });
  return (
    <main
      className="duo-customer-display"
      data-testid="duo-customer-display"
      style={brandStyle}
      data-status={display.status}
    >
      <section aria-live="polite" className="duo-customer-display-copy">
        <header className="duo-customer-brand">
          <span className="duo-customer-brand-mark">
            <ScanOrgLogo
              className="duo-customer-brand-logo"
              src={logoUrl}
              name=""
              fallback={<span aria-hidden>{brandName.charAt(0) || 'P'}</span>}
            />
          </span>
          <p>{brandName}</p>
        </header>
        <p className="duo-customer-display-eyebrow">{copy.eyebrow}</p>
        <h1>{copy.title}</h1>
        {copy.hint ? <p className="duo-customer-display-hint">{copy.hint}</p> : null}
      </section>
      <div aria-hidden="true" className="duo-customer-buddy">
        <CustomerBuddy
          className="duo-customer-buddy-art"
          status={buddyStatus(display.status)}
          replay={display.revision}
        />
      </div>
    </main>
  );
}
