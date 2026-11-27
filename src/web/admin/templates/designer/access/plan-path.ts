const PLAN_PATH = /^scan\.access\.plans\[(\d+)\]/;

/** The access plan an issue path names, if any. */
export const planIndexOf = (path: string | undefined): number | null => {
  const m = PLAN_PATH.exec(path ?? '');
  return m ? Number(m[1]) : null;
};
