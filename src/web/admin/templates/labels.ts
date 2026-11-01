const STYLE_LABELS: Record<string, string> = {
  boardingPass: 'Boarding pass',
  coupon: 'Coupon',
  eventTicket: 'Event ticket',
  generic: 'Generic',
  posterEventTicket: 'Poster ticket',
  posterGeneric: 'Poster',
  storeCard: 'Store card',
};

export function styleLabel(style: string): string {
  return (
    STYLE_LABELS[style] ?? style.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
  );
}

export function styleList(styles: readonly string[]): string {
  return styles.map(styleLabel).join(', ');
}
