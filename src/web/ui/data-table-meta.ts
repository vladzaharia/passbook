// Column options DataTable reads from TanStack's column meta.
declare module '@tanstack/react-table' {
  interface ColumnMeta<TData, TValue> {
    /** Hide the column below this breakpoint. */
    hideBelow?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
    /**
     * The column takes the slack left after the others, and its cell truncates (a title). Give
     * the cell content `contain-inline-size` so a long title never widens the table.
     */
    grow?: boolean;
    /**
     * Meta cells (template, org, dates): one line, truncated (set a title in the cell). `wide`
     * allows more from xl (emails).
     */
    nowrap?: boolean | 'wide';
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
  '2xl': 'max-2xl:hidden',
} as const;
