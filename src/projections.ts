/**
 * Minimal client-side projection support.
 *
 * Some county ArcGIS servers (notably Hamilton County TN, wkid 103152 /
 * EPSG:6576) silently ignore WGS84 input geometry instead of reprojecting it —
 * a point query with inSR=4326 returns zero features with no error. For those
 * layers we project the point ourselves and query in the layer's native SR.
 *
 * Implemented: Lambert Conformal Conic (2SP) on GRS80, output in US survey feet.
 */

interface Lcc2spParams {
  /** Latitude of false origin (deg) */
  lat0: number;
  /** Longitude of false origin / central meridian (deg) */
  lon0: number;
  /** Standard parallels (deg) */
  sp1: number;
  sp2: number;
  /** False easting/northing in METERS */
  fe: number;
  fn: number;
}

const GRS80_A = 6378137.0;
const GRS80_F = 1 / 298.257222101;
const E2 = GRS80_F * (2 - GRS80_F);
const E = Math.sqrt(E2);
const METERS_PER_US_FOOT = 1200 / 3937;

const D2R = Math.PI / 180;

function mFn(phi: number): number {
  return Math.cos(phi) / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
}
function tFn(phi: number): number {
  return (
    Math.tan(Math.PI / 4 - phi / 2) /
    Math.pow((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi)), E / 2)
  );
}

/** Forward LCC 2SP: lon/lat (deg, WGS84≈NAD83 for parcel purposes) → native x/y in US survey feet. */
export function lccForwardFeetUS(lon: number, lat: number, p: Lcc2spParams): { x: number; y: number } {
  const phi = lat * D2R;
  const lam = lon * D2R;
  const phi0 = p.lat0 * D2R;
  const lam0 = p.lon0 * D2R;
  const phi1 = p.sp1 * D2R;
  const phi2 = p.sp2 * D2R;

  const m1 = mFn(phi1);
  const m2 = mFn(phi2);
  const t0 = tFn(phi0);
  const t1 = tFn(phi1);
  const t2 = tFn(phi2);

  const n = (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
  const F = m1 / (n * Math.pow(t1, n));
  const rho0 = GRS80_A * F * Math.pow(t0, n);
  const t = tFn(phi);
  const rho = GRS80_A * F * Math.pow(t, n);
  const theta = n * (lam - lam0);

  const xMeters = p.fe + rho * Math.sin(theta);
  const yMeters = p.fn + rho0 - rho * Math.cos(theta);
  return { x: xMeters / METERS_PER_US_FOOT, y: yMeters / METERS_PER_US_FOOT };
}

/** EPSG:6576 — NAD83(2011) / Tennessee (ftUS). ESRI wkid 103152 is the same CRS. */
const TN_STATE_PLANE: Lcc2spParams = {
  lat0: 34 + 20 / 60,
  lon0: -86,
  sp1: 35 + 15 / 60,
  sp2: 36 + 25 / 60,
  fe: 600000,
  fn: 0,
};

/** wkids we can project into client-side. */
const SUPPORTED: Record<number, Lcc2spParams> = {
  103152: TN_STATE_PLANE,
  6576: TN_STATE_PLANE,
  2274: TN_STATE_PLANE, // NAD83 / Tennessee (ftUS) — same projection parameters
};

export function canProjectTo(wkid: number): boolean {
  return wkid in SUPPORTED;
}

/**
 * Project a WGS84 lon/lat into the given wkid (US feet). Returns null if the
 * wkid isn't supported — caller should then query with inSR=4326 and let the
 * server reproject.
 */
export function projectPoint(lon: number, lat: number, wkid: number): { x: number; y: number } | null {
  const params = SUPPORTED[wkid];
  if (!params) return null;
  return lccForwardFeetUS(lon, lat, params);
}
