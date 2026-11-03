import { createContext, useContext } from 'react';

/** True inside a Card: states there default to their inline form (ErrorState). */
export const InCardContext = createContext(false);

export const useInCard = (): boolean => useContext(InCardContext);
