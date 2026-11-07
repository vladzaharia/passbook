import { useEffect, useState } from 'react';
import { getNativeCapabilities, NATIVE_CAPABILITIES_EVENT } from './native-capabilities.ts';
export function useNativeCapabilities() {
  const [capabilities, setCapabilities] = useState(getNativeCapabilities);
  useEffect(() => {
    const update = () => {
      const next = getNativeCapabilities();
      setCapabilities(next ? { ...next } : undefined);
    };
    window.addEventListener(NATIVE_CAPABILITIES_EVENT, update);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener(NATIVE_CAPABILITIES_EVENT, update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return capabilities;
}
