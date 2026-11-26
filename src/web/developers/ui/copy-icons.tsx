import { Check, Copy } from 'lucide-react';

/** Both glyphs; CSS shows the check for 1.5 s after a copy (`[data-state="copied"]`). */
export function CopyIcons() {
  return (
    <>
      <Copy className="lucide ic-copy" aria-hidden="true" />
      <Check className="lucide ic-done" aria-hidden="true" />
    </>
  );
}
