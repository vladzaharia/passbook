import { createContext } from 'react';

/** Asset grants belong to the managed device as well as its signed-in administrator. */
export const ScanAssetScope = createContext<
  | {
      orgId: string;
      setupId: string;
      timeZone: string;
    }
  | undefined
>(undefined);
