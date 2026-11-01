// Column options DataTable reads from TanStack's column meta.
declare module '@tanstack/react-table' {
  interface ColumnMeta<TData, TValue> {
    /** Hide the column below this breakpoint. */
    hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
    /** Meta cells (template, org, dates): one line, truncated (set a title in the cell). */
    nowrap?: boolean;
    /** Right-align numbers. */
    numeric?: boolean;
    /** Leave the column out of the stacked (below md) layout. */
    stackHidden?: boolean;
  }
}

export const HIDE_BELOW = {
  sm: 'max-sm:hidden',
  md: 'max-md:hidden',
  lg: 'max-lg:hidden',
  xl: 'max-xl:hidden',
} as const;
