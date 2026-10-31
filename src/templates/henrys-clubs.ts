// Apple Maps place IDs resolved from the member-provided share links on 2026-10-30.
// Keep IDs as strings: Queen Anne's ID has 15 hex digits, which is valid.
export const clubs = {
  'Capitol Hill': {
    id: 'capitol-hill', name: 'Capitol Hill',
    placeIdentifier: 'I23C636C7300F20FD',
    shareURL: 'https://maps.apple/p/8x6-WXEcd1wjie',
    address: '1617 Boylston Ave, Seattle, WA 98122',
    latitude: 47.615835, longitude: -122.323555,
    phone: '(206) 644-7797'
  },
  'Queen Anne': {
    id: 'queen-anne', name: 'Queen Anne',
    placeIdentifier: 'I1F4F79088B704BE',
    shareURL: 'https://maps.apple/p/oU6H5zv.RjwJdC',
    address: '14 Mercer St, Seattle, WA 98109',
    latitude: 47.624765, longitude: -122.356206,
    phone: '(206) 644-0969'
  }
} as const;

export function homeClub(value: unknown) { return value === 'Queen Anne' ? clubs['Queen Anne'] : clubs['Capitol Hill']; }
export function directionsURL(value: unknown) {
  const club=homeClub(value);
  return `https://maps.apple.com/directions?destination=${club.latitude},${club.longitude}&destination-place-id=${club.placeIdentifier}`;
}
