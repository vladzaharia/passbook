/** Curated: IATA code, city, IANA zone, standard-time offset in hours, latitude, longitude. */
export interface Airport {
  iata: string;
  city: string;
  tz: string;
  offset: number;
  lat: number;
  lng: number;
}

const a = (
  iata: string,
  city: string,
  tz: string,
  offset: number,
  lat: number,
  lng: number,
): Airport => ({
  iata,
  city,
  tz,
  offset,
  lat,
  lng,
});

export const AIRPORTS: readonly Airport[] = [
  a('JFK', 'New York', 'America/New_York', -5, 40.64, -73.78),
  a('LAX', 'Los Angeles', 'America/Los_Angeles', -8, 33.94, -118.41),
  a('ORD', 'Chicago', 'America/Chicago', -6, 41.98, -87.9),
  a('SEA', 'Seattle', 'America/Los_Angeles', -8, 47.45, -122.31),
  a('DEN', 'Denver', 'America/Denver', -7, 39.86, -104.67),
  a('ATL', 'Atlanta', 'America/New_York', -5, 33.64, -84.43),
  a('MIA', 'Miami', 'America/New_York', -5, 25.79, -80.29),
  a('SFO', 'San Francisco', 'America/Los_Angeles', -8, 37.62, -122.38),
  a('YYZ', 'Toronto', 'America/Toronto', -5, 43.68, -79.63),
  a('MEX', 'Mexico City', 'America/Mexico_City', -6, 19.44, -99.07),
  a('GRU', 'Sao Paulo', 'America/Sao_Paulo', -3, -23.43, -46.47),
  a('EZE', 'Buenos Aires', 'America/Argentina/Buenos_Aires', -3, -34.82, -58.54),
  a('LHR', 'London', 'Europe/London', 0, 51.47, -0.45),
  a('CDG', 'Paris', 'Europe/Paris', 1, 49.01, 2.55),
  a('FRA', 'Frankfurt', 'Europe/Berlin', 1, 50.03, 8.57),
  a('AMS', 'Amsterdam', 'Europe/Amsterdam', 1, 52.31, 4.76),
  a('MAD', 'Madrid', 'Europe/Madrid', 1, 40.47, -3.57),
  a('FCO', 'Rome', 'Europe/Rome', 1, 41.8, 12.25),
  a('IST', 'Istanbul', 'Europe/Istanbul', 3, 41.26, 28.74),
  a('DXB', 'Dubai', 'Asia/Dubai', 4, 25.25, 55.36),
  a('BKK', 'Bangkok', 'Asia/Bangkok', 7, 13.69, 100.75),
  a('SIN', 'Singapore', 'Asia/Singapore', 8, 1.36, 103.99),
  a('HKG', 'Hong Kong', 'Asia/Hong_Kong', 8, 22.31, 113.91),
  a('PEK', 'Beijing', 'Asia/Shanghai', 8, 40.08, 116.58),
  a('ICN', 'Seoul', 'Asia/Seoul', 9, 37.46, 126.44),
  a('NRT', 'Tokyo', 'Asia/Tokyo', 9, 35.77, 140.39),
  a('SYD', 'Sydney', 'Australia/Sydney', 10, -33.94, 151.18),
  a('AKL', 'Auckland', 'Pacific/Auckland', 12, -37.01, 174.79),
  a('JNB', 'Johannesburg', 'Africa/Johannesburg', 2, -26.14, 28.25),
  a('CAI', 'Cairo', 'Africa/Cairo', 2, 30.12, 31.41),
];

/** Great-circle distance in km. */
export function distanceKm(p: Airport, q: Airport): number {
  const rad = Math.PI / 180;
  const dLat = (q.lat - p.lat) * rad;
  const dLng = (q.lng - p.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p.lat * rad) * Math.cos(q.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
