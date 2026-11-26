const ACTION = /^scan\.actions\.(\d+)/;

/** The scan action an issue path names, if any. */
export function actionIndexOf(path: string | undefined): number | null {
  const m = ACTION.exec(path ?? '');
  return m ? Number(m[1]) : null;
}
