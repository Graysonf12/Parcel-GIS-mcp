/**
 * Shared ArcGIS REST client utilities.
 */

export const CHARACTER_LIMIT = 25000;
const TIMEOUT_MS = 30000;
const USER_AGENT = "parcel-gis-mcp-server/1.0 (Hutton SIR Research Agent)";

export interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: {
    rings?: number[][][];
    x?: number;
    y?: number;
  };
}

export interface ArcgisQueryResult {
  features?: ArcgisFeature[];
  fields?: { name: string; type: string; alias?: string }[];
  exceededTransferLimit?: boolean;
  error?: { code: number; message: string; details?: string[] };
  [key: string]: unknown;
}

/** Reject obviously unsafe / non-ArcGIS URLs (basic SSRF guard). */
export function assertSafeArcgisUrl(rawUrl: string, allowNonRest = false): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  const host = url.hostname;
  if (
    host === "localhost" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "0.0.0.0" ||
    host === "[::1]"
  ) {
    throw new Error("Private/loopback hosts are not allowed.");
  }
  if (!allowNonRest && !url.pathname.toLowerCase().includes("/rest/services")) {
    throw new Error(
      "URL must be an ArcGIS REST endpoint (path must contain /rest/services). " +
        "For non-ArcGIS APIs use the dedicated tool (e.g. gis_elevation_at_point for USGS EPQS)."
    );
  }
  return url;
}

/** GET a JSON document with timeout + friendly errors. */
export async function fetchJson(
  rawUrl: string,
  params: Record<string, string | number | boolean | undefined> = {},
  allowNonRest = false
): Promise<Record<string, unknown>> {
  const url = assertSafeArcgisUrl(rawUrl, allowNonRest);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  if (!url.searchParams.has("f") && !allowNonRest) url.searchParams.set("f", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError"
      ? `Request timed out after ${TIMEOUT_MS / 1000}s`
      : err instanceof Error ? err.message : String(err);
    throw new Error(
      `Network error reaching ${url.hostname}: ${msg}. ` +
        `The host may be down or blocking non-browser clients — log the outcome in the Jurisdiction Portal Registry.`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} from ${url.hostname}. ` +
        (res.status === 403
          ? "The server refused this client (bot-blocking or referrer rules). Log as ❌ in the Portal Registry and fall back per SIR doctrine."
          : res.status === 404
            ? "Endpoint not found — the service may have moved; re-discover it via the server's /rest/services directory."
            : "Retry once; if persistent, log the outcome in the Portal Registry.")
    );
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Response from ${url.hostname} was not JSON (got ${text.slice(0, 120)}...). ` +
        `The endpoint may be HTML-only — treat as JS-rendered/blocked per Portal Registry conventions.`
    );
  }
}

/** Run a layer query. `layerUrl` must end at the layer index (e.g. .../FeatureServer/0). */
export async function queryLayer(
  layerUrl: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<ArcgisQueryResult> {
  const base = layerUrl.replace(/\/+$/, "");
  const data = (await fetchJson(`${base}/query`, params)) as ArcgisQueryResult;
  if (data.error) {
    const e = data.error;
    throw new Error(
      `ArcGIS error ${e.code}: ${e.message}${e.details?.length ? ` — ${e.details.join("; ")}` : ""}. ` +
        `Check the where clause / field names against the layer schema (fetch the layer root with f=json).`
    );
  }
  return data;
}

/** Escape a value for use inside an ArcGIS SQL string literal. */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Area-weighted centroid of the largest ring of a polygon (lon/lat in, lon/lat out). */
export function polygonCentroid(rings: number[][][]): { lon: number; lat: number } | null {
  if (!rings.length) return null;
  let best: { area: number; cx: number; cy: number } | null = null;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      const cross = x1 * y2 - x2 * y1;
      a += cross;
      cx += (x1 + x2) * cross;
      cy += (y1 + y2) * cross;
    }
    if (a === 0) continue;
    const area = Math.abs(a / 2);
    if (!best || area > best.area) {
      best = { area, cx: cx / (3 * a), cy: cy / (3 * a) };
    }
  }
  return best ? { lon: best.cx, lat: best.cy } : null;
}

/** Drop null/empty attributes so 134-field FL rows don't flood the context. */
export function compactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

/** Truncate a text payload at the character limit with an explanatory suffix. */
export function enforceCharLimit(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[TRUNCATED at ${CHARACTER_LIMIT} chars — narrow the query (fewer results via 'limit', or restrict 'out_fields') to see the rest.]`
  );
}
