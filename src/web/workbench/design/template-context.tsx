import { createContext, useContext } from 'react';

/** The template the designer is open on, for the panels that name it (Code, Try on my phone). */
const TemplateContext = createContext<{ id: string; name: string } | null>(null);

export const TemplateProvider = TemplateContext.Provider;

export function useOpenTemplate(): { id: string; name: string } {
  const open = useContext(TemplateContext);
  if (!open) throw new Error('useOpenTemplate outside the Design page.');
  return open;
}
