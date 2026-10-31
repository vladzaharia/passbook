import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from './icon-button.tsx';

export interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
}

export function CopyButton({ value, label = 'Copy', className }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // Clipboard needs a secure context and permission; tell the user instead of failing silently.
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }

  return (
    <>
      <IconButton
        label={state === 'copied' ? 'Copied' : label}
        size="sm"
        className={className}
        icon={state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
        onClick={copy}
      />
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </>
  );
}
