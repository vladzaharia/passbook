import { createContext, useContext } from 'react';

/** The console scope a page is in, as the root breadcrumb and the middle of the tab title. */
export interface ScopeCrumb {
  label: string;
  to: string;
}

export const ScopeCrumbContext = createContext<ScopeCrumb | undefined>(undefined);

export const useScopeCrumb = (): ScopeCrumb | undefined => useContext(ScopeCrumbContext);
