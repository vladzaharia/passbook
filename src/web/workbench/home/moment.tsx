import { useEffect, useRef } from 'react';
import { Celebrate } from '../../ui/celebrate.tsx';
import { toast } from '../../ui/toaster.tsx';

/**
 * A milestone's moment: foil sparks over its seat, and one toast with a View action. Its own chunk,
 * loaded only when a milestone fires; nothing of it is in the shell or Home's first paint.
 */
export default function Moment({ text, view, go }: { text: string; view: string; go: () => void }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    toast.action(text, { label: view, onClick: go });
  }, [text, view, go]);
  return <Celebrate when size="lg" />;
}
