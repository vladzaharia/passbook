/** `ScanTextField`: the scanner's only text input. It registers itself so a reader's burst is a scan. */
import { createContext, type Ref, useContext, useEffect, useRef } from 'react';
import { Input, type InputProps } from '../../ui/input.tsx';
import type { WedgeFields } from './wedge-source.ts';

export const WedgeFieldsContext = createContext<WedgeFields | null>(null);

/** Registers `ref`'s element with the scan source; `setValue` puts the field back after a burst. */
export function useWedgeField(
  ref: { current: HTMLInputElement | HTMLTextAreaElement | null },
  setValue: (value: string) => void,
): void {
  const fields = useContext(WedgeFieldsContext);
  const latest = useRef(setValue);
  latest.current = setValue;
  useEffect(() => {
    const el = ref.current;
    if (!fields || !el) return;
    return fields.register(el, (value) => {
      el.value = value;
      latest.current(value);
    });
  }, [fields, ref]);
}

export interface ScanTextFieldProps extends InputProps {
  /** A controlled field is told the value it was restored to after a reader's burst. */
  onValueRestore?: (value: string) => void;
}

export function ScanTextField({ onValueRestore, ref, ...props }: ScanTextFieldProps) {
  const own = useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null) => {
    own.current = el;
    const outer = ref as Ref<HTMLInputElement> | undefined;
    if (typeof outer === 'function') outer(el);
    else if (outer) (outer as { current: HTMLInputElement | null }).current = el;
  };
  useWedgeField(own, (value) => onValueRestore?.(value));
  return <Input ref={setRefs} {...props} />;
}
