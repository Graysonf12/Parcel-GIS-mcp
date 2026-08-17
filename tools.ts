/**
 * Tool registrations for parcel-gis-mcp-server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ArcgisFeature,
  compactAttributes,
  enforceCharLimit,
  fetchJson,
  polygonCentroid,
  queryLayer,
  sqlQuote,
} from "./arcgis.js";
import {
  getIdentifyLayer,
  getParcelSource,
  IDENTIFY_LAYERS,
  PARCEL_SOURCES,
  ParcelSource,
} from "./registry.js";

const sourceIds = PARCEL_SOURCES.map((s) => s.id).join(", ");

function verificationNote(source: ParcelSource): string {
  return source.verified
    ? `endpoint verified live ${source.verified}`
    : "endpoint NOT yet verified (⟨verify at run⟩) — treat a clean result as the verification event and log it in the Jurisdiction Portal Registry";
}

/** Summarize one feature using the source's field map (markdown lines). */
function summarizeParcel(source: ParcelSource, f: ArcgisFeature): string[] {
  const a = f.attributes;
  const fm = source.fieldMap;
  const lines: string[] = [];
  const idVal = a[source.idField];
  lines.push(`**${source.idField}: ${idVal ?? "(none)"}**`);
  for (const alias of source.idAliases ?? []) {
    if (a[alias] != null) lines.push(`- ${alias}: ${a[alias]}`);
  }
  if (fm.owner) {
    const owner = fm.owner.map((k) => a[k]).filter((v) => v != null).join(" / ");
    if (owner) lines.push(`- Owner: ${owner}`);
  }
  if (fm.situsAddress) {
    const addr = fm.situsAddress.map((k) => a[k]).filter((v) => v != null && v !== "").join(", ");
    const cityZip = [fm.city && a[fm.city], fm.zip && a[fm.zip]].filter(Boolean).join(" ");
    if (addr || cityZip) lines.push(`- Situs: ${[addr, cityZip].filter(Boolean).join(", ")}`);
  }
  if (fm.area && a[fm.area.field] != null) {
    const raw = Number(a[fm.area.field]);
    const acres = fm.area.unit === "sqft" ? raw / 43560 : fm.area.unit === "sqm" ? raw / 4046.856 : raw;
    lines.push(`- Area: ${acres.toFixed(3)} ac (${raw} ${fm.area.unit} raw)`);
  }
  if (fm.useCode) {
    const codes = fm.useCode.map((k) => (a[k] != null ? `${k}=${a[k]}` : null)).filter(Boolean).join(", ");
    if (codes) lines.push(`- Use code: ${codes}`);
  }
  if (fm.legal && a[fm.legal] != null) lines.push(`- Legal: ${a[fm.legal]}`);
  if (fm.value && a[fm.value] != null) lines.push(`- Just/assessed value: ${a[fm.value]}`);
  if (fm.salePrice && a[fm.salePrice] != null) {
    lines.push(`- Last sale: ${a[fm.salePrice]}${fm.saleYear && a[fm.saleYear] != null ? ` (${a[fm.saleYear]})` : ""}`);
  }
  return lines;
}

function featureCentroid(f: ArcgisFeature): { lon: number; lat: number } | null {
  if (f.geometry?.rings) return polygonCentroid(f.geometry.rings);
  if (typeof f.geometry?.x === "number" && typeof f.geometry?.y === "number") {
    return { lon: f.geometry.x, lat: f.geometry.y };
  }
  return null;
}

export function registerTools(server: McpServer): void {
  // ------------------------------------------------------------------
  // parcel_lookup
  // ------------------------------------------------------------------
  server.registerTool(
    "parcel_lookup",
    {
      title: "Parcel lookup by identifier",
      description: `Look up a parcel by its identifier (PCN / APN / PVA parcel ID / PARCELID — the SIR §0A primary key) against a registered public ArcGIS parcel layer.

Runs an exact match on the source's identifier field first; if that returns nothing it automatically retries as a contains (LIKE) match and, where the source defines alias identifier fields (PIN, LRSN...), tries those too. Returns parcel attributes (nulls stripped), a plain-language summary, and the polygon centroid in WGS84 lon/lat — feed the centroid straight into the FEMA flood connector and gis_elevation_at_point.

Args:
  - source_id (string): registry key of the parcel source. One of: ${sourceIds}. Use gis_registry_list to see coverage + verification status.
  - parcel_id (string): the identifier exactly as supplied by the requester. Formatting variants (dashes, dots) are handled by the LIKE fallback, but if all matches fail, retry with the jurisdiction's canonical formatting before concluding the identifier is wrong.
  - out_fields (string, optional): comma-separated field list or "*" (default "*").
  - include_geometry (boolean, default true): compute and return the centroid.

Returns: matched parcel(s) with match_type ("exact" | "contains" | "alias:<field>"), attributes, centroid {lon, lat}, and the source's verification status.

Error handling: a zero-match result explains which strategies were tried. An ArcGIS field error usually means the registry entry's idField is wrong for that layer — read the layer schema with gis_raw_query (f=json on the layer root) and fix the registry.`,
      inputSchema: {
        source_id: z.string().describe(`Registry key: ${sourceIds}`),
        parcel_id: z.string().min(1).max(60).describe("Parcel identifier as supplied at SIR kickoff"),
        out_fields: z.string().default("*").describe('Comma-separated fields or "*"'),
        include_geometry: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ source_id, parcel_id, out_fields, include_geometry }) => {
      const source = getParcelSource(source_id);
      if (!source) {
        return {
          content: [{ type: "text", text: `Error: unknown source_id '${source_id}'. Valid: ${sourceIds}. Use gis_registry_list.` }],
          isError: true,
        };
      }
      try {
        const attempts: { label: string; where: string }[] = [
          { label: "exact", where: `${source.idField} = ${sqlQuote(parcel_id)}` },
          { label: "contains", where: `${source.idField} LIKE ${sqlQuote("%" + parcel_id + "%")}` },
          ...(source.idAliases ?? []).map((alias) => ({
            label: `alias:${alias}`,
            where: `${alias} = ${sqlQuote(parcel_id)}`,
          })),
        ];

        for (const attempt of attempts) {
          const data = await queryLayer(source.url, {
            where: attempt.where,
            outFields: out_fields,
            returnGeometry: include_geometry,
            outSR: 4326,
            resultRecordCount: 5,
          });
          const features = data.features ?? [];
          if (!features.length) continue;

          const results = features.map((f) => ({
            match_type: attempt.label,
            attributes: compactAttributes(f.attributes),
            centroid: include_geometry ? featureCentroid(f) : null,
          }));
          const output = {
            source_id: source.id,
            source_name: source.name,
            verification: verificationNote(source),
            match_count: features.length,
            results,
          };
          const md: string[] = [
            `# Parcel lookup: ${parcel_id}`,
            `Source: ${source.name} (${verificationNote(source)})`,
            `Match type: ${attempt.label} · ${features.length} feature(s)`,
            "",
          ];
          for (const [i, f] of features.entries()) {
            md.push(...summarizeParcel(source, f));
            const c = results[i].centroid;
            if (c) md.push(`- Centroid (WGS84): ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)} — use for FEMA flood + elevation lookups`);
            md.push("");
          }
          if (source.notes) md.push(`_Source note: ${source.notes}_`);
          return {
            content: [{ type: "text", text: enforceCharLimit(md.join("\n")) }],
            structuredContent: output,
          };
        }

        return {
          content: [{
            type: "text",
            text:
              `No parcel matched '${parcel_id}' in ${source.name} (tried exact, contains${source.idAliases?.length ? ", " + source.idAliases.join(", ") : ""}). ` +
              `Next steps: (1) retry with the jurisdiction's canonical identifier formatting, (2) confirm the identifier with the requester — under SIR §0A a supplied identifier that fails portal verification is tagged [Confirmed · user-supplied — portal verification pending], never silently replaced by an address lookup.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error querying ${source.name}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // parcel_search_by_address
  // ------------------------------------------------------------------
  server.registerTool(
    "parcel_search_by_address",
    {
      title: "Parcel search by situs address",
      description: `Search a registered parcel layer by situs (physical) address fragment. This is the SIR §0A(5) FALLBACK path for when no parcel identifier was supplied at kickoff — the identifier path (parcel_lookup) is always preferred when an identifier exists.

Args:
  - source_id (string): registry key. One of: ${sourceIds}. Sources with no address fields (geometry-only layers like ky-jefferson) reject this tool with guidance.
  - address (string): street-number + street-name fragment, e.g. "4310 BARDSTOWN" or "9350 OSLO". Case-insensitive contains-match. Do NOT include city/state/zip in this argument.
  - city (string, optional): filter by situs city where the source has a city field.
  - limit (number, default 10, max 50).

Returns: matching parcels with the same summary/centroid treatment as parcel_lookup, plus has_more when the layer reports more rows than returned.`,
      inputSchema: {
        source_id: z.string().describe(`Registry key: ${sourceIds}`),
        address: z.string().min(3).max(120).describe("Street number + name fragment, no city/zip"),
        city: z.string().max(60).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ source_id, address, city, limit }) => {
      const source = getParcelSource(source_id);
      if (!source) {
        return {
          content: [{ type: "text", text: `Error: unknown source_id '${source_id}'. Valid: ${sourceIds}.` }],
          isError: true,
        };
      }
      if (!source.addressFields?.length) {
        return {
          content: [{
            type: "text",
            text: `Source '${source.id}' has no address fields (geometry/ID-only layer). ${source.notes ?? ""} Use parcel_lookup with an identifier instead.`,
          }],
          isError: true,
        };
      }
      try {
        const addrClause = source.addressFields
          .map((f) => `UPPER(${f}) LIKE ${sqlQuote("%" + address.toUpperCase() + "%")}`)
          .join(" OR ");
        const cityClause =
          city && source.fieldMap.city
            ? ` AND UPPER(${source.fieldMap.city}) LIKE ${sqlQuote("%" + city.toUpperCase() + "%")}`
            : "";
        const data = await queryLayer(source.url, {
          where: `(${addrClause})${cityClause}`,
          outFields: "*",
          returnGeometry: true,
          outSR: 4326,
          resultRecordCount: limit,
        });
        const features = data.features ?? [];
        if (!features.length) {
          return {
            content: [{
              type: "text",
              text: `No parcels matched address fragment '${address}'${city ? ` in city '${city}'` : ""} in ${source.name}. Try a shorter fragment (number + first street word), drop the city filter, or check street-name abbreviations (RD vs ROAD).`,
            }],
          };
        }
        const results = features.map((f) => ({
          attributes: compactAttributes(f.attributes),
          centroid: featureCentroid(f),
        }));
        const output = {
          source_id: source.id,
          source_name: source.name,
          verification: verificationNote(source),
          count: features.length,
          has_more: data.exceededTransferLimit === true || features.length === limit,
          results,
        };
        const md: string[] = [
          `# Address search: '${address}'${city ? ` (city: ${city})` : ""}`,
          `Source: ${source.name} · ${features.length} result(s)${output.has_more ? " (more may exist — raise limit or narrow)" : ""}`,
          "",
        ];
        for (const [i, f] of features.entries()) {
          md.push(...summarizeParcel(source, f));
          const c = results[i].centroid;
          if (c) md.push(`- Centroid (WGS84): ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`);
          md.push("");
        }
        md.push(
          "_Reminder (SIR §0A): address results are a fallback resolution — confirm the parcel identifier with the requester before treating any of these as the subject site._"
        );
        return {
          content: [{ type: "text", text: enforceCharLimit(md.join("\n")) }],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error querying ${source.name}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // gis_layer_identify
  // ------------------------------------------------------------------
  server.registerTool(
    "gis_layer_identify",
    {
      title: "Point-in-polygon identify against a GIS layer",
      description: `Return the feature(s) of a polygon layer that contain a WGS84 point. This answers "which zoning district / municipality / water-management district / land-use class is this parcel in" — pair it with the centroid from parcel_lookup.

Args:
  - layer (string): either a registered identify-layer id (${IDENTIFY_LAYERS.map((l) => l.id).join(", ")}) or a full ArcGIS REST layer URL ending in the layer index (e.g. https://host/arcgis/rest/services/Zoning/MapServer/0). Arbitrary URLs let you use any county zoning layer before it's promoted into the registry.
  - lon (number), lat (number): WGS84 coordinates of the point (use the parcel centroid).
  - out_fields (string, default "*").

Returns: intersecting feature attributes (nulls stripped). Zero features = the point is outside the layer's coverage, or the layer is the wrong one — verify with a known-inside test point before concluding anything.

Registered layers may carry verified=false ("verify at run") — a clean result IS the verification; log it in the Jurisdiction Portal Registry.`,
      inputSchema: {
        layer: z.string().min(3).describe("Registered layer id or full ArcGIS REST layer URL"),
        lon: z.number().min(-180).max(180),
        lat: z.number().min(-90).max(90),
        out_fields: z.string().default("*"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ layer, lon, lat, out_fields }) => {
      try {
        const registered = getIdentifyLayer(layer);
        const url = registered ? registered.url : layer;
        if (!url) {
          return {
            content: [{
              type: "text",
              text: `Registered layer '${layer}' has no URL pinned yet. ${registered?.notes ?? ""} Pass a full layer URL instead once discovered.`,
            }],
            isError: true,
          };
        }
        const data = await queryLayer(url, {
          geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
          geometryType: "esriGeometryPoint",
          inSR: 4326,
          spatialRel: "esriSpatialRelIntersects",
          outFields: out_fields,
          returnGeometry: false,
        });
        const features = data.features ?? [];
        const name = registered?.name ?? url;
        if (!features.length) {
          return {
            content: [{
              type: "text",
              text: `No features of '${name}' contain point (${lat}, ${lon}). Either the point is outside coverage or this is the wrong layer — sanity-check with a point known to be inside.`,
            }],
          };
        }
        const results = features.map((f) => compactAttributes(f.attributes));
        const output = { layer: name, point: { lon, lat }, count: features.length, results };
        const md = [
          `# Identify: ${name}`,
          `Point: ${lat.toFixed(6)}, ${lon.toFixed(6)} · ${features.length} feature(s)`,
          "",
          ...results.map((r, i) => `## Feature ${i + 1}\n` + Object.entries(r).map(([k, v]) => `- ${k}: ${v}`).join("\n")),
        ];
        return {
          content: [{ type: "text", text: enforceCharLimit(md.join("\n")) }],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error identifying against layer: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // gis_elevation_at_point
  // ------------------------------------------------------------------
  server.registerTool(
    "gis_elevation_at_point",
    {
      title: "Ground elevation at a point (USGS EPQS)",
      description: `Ground-surface elevation for a WGS84 point from the USGS Elevation Point Query Service (3DEP). Covers SIR topography path 1 (Field Reference §3A) and satisfies Quality Rule 8 — coordinates and relative topography are always desk-answered. Query several points across a site (corners + centroid from parcel_lookup) to characterize relative topography and fall.

Args:
  - lon (number), lat (number): WGS84 coordinates.
  - units ("Feet" | "Meters", default "Feet").

Returns: elevation value + resolution metadata from EPQS. Note: EPQS was ⟨verify at run⟩ in the Portal Registry — a clean result is the verification event.`,
      inputSchema: {
        lon: z.number().min(-180).max(180),
        lat: z.number().min(-90).max(90),
        units: z.enum(["Feet", "Meters"]).default("Feet"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ lon, lat, units }) => {
      try {
        const data = await fetchJson(
          "https://epqs.nationalmap.gov/v1/json",
          { x: lon, y: lat, units, wkid: 4326, includeDate: false },
          true
        );
        const value = (data as { value?: number | string }).value;
        if (value === undefined || value === null || Number(value) <= -999999) {
          return {
            content: [{ type: "text", text: `EPQS returned no elevation for (${lat}, ${lon}) — point may be outside 3DEP coverage (open water, territory gap).` }],
          };
        }
        const output = { lon, lat, units, elevation: Number(value), raw: data };
        return {
          content: [{ type: "text", text: `Elevation at ${lat.toFixed(6)}, ${lon.toFixed(6)}: **${Number(value).toFixed(2)} ${units.toLowerCase()}** (USGS EPQS / 3DEP).` }],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error querying USGS EPQS: ${err instanceof Error ? err.message : String(err)}. Fallback: USGS TNM viewer manual read, coordinates carried with the route.` }],
          isError: true,
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // gis_raw_query
  // ------------------------------------------------------------------
  server.registerTool(
    "gis_raw_query",
    {
      title: "Raw ArcGIS REST GET (escape hatch)",
      description: `Direct GET against any public ArcGIS REST endpoint (URL must contain /rest/services). The discovery escape hatch, mirroring municode_raw_get: list a server's services (…/rest/services?f=json), list a service's layers, read a layer's field schema, or run a query with hand-built parameters when the shaped tools don't fit.

Use this to onboard NEW jurisdictions: find the county's parcel/zoning layer, read its schema, then promote a proper entry into the registry (src/registry.ts) so future runs use the shaped tools.

Args:
  - url (string): full ArcGIS REST URL WITHOUT query string.
  - params (object, optional): query parameters as string key/values (f=json is added automatically). For layer queries include where/outFields/etc.

Returns: raw JSON (truncated at the character limit — use resultRecordCount / outFields to narrow).`,
      inputSchema: {
        url: z.string().url().describe("ArcGIS REST endpoint, no query string"),
        params: z.record(z.string()).optional().describe("Query params, e.g. {\"where\":\"1=1\",\"outFields\":\"*\",\"resultRecordCount\":\"5\"}"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, params }) => {
      try {
        const data = await fetchJson(url, params ?? {});
        return {
          content: [{ type: "text", text: enforceCharLimit(JSON.stringify(data, null, 2)) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ------------------------------------------------------------------
  // gis_registry_list
  // ------------------------------------------------------------------
  server.registerTool(
    "gis_registry_list",
    {
      title: "List registered parcel sources and identify layers",
      description: `List every parcel source and identify layer this server knows, with coverage, identifier field, verification date (or ⟨verify at run⟩ status), and usage notes. Call this first on a new jurisdiction to pick the right source_id — and to see which entries still need their first live verification so the outcome can be logged in the Jurisdiction Portal Registry.`,
      inputSchema: {
        state: z.string().length(2).optional().describe("Optional 2-letter state filter, e.g. FL"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ state }) => {
      const st = state?.toUpperCase();
      const sources = PARCEL_SOURCES.filter((s) => !st || s.state === st);
      const layers = IDENTIFY_LAYERS.filter((l) => !st || l.states.includes(st));
      const md: string[] = ["# Parcel sources", ""];
      for (const s of sources) {
        md.push(`## ${s.id} — ${s.name}`);
        md.push(`- State: ${s.state} · ID field: ${s.idField}${s.idAliases?.length ? ` (aliases: ${s.idAliases.join(", ")})` : ""}`);
        md.push(`- Address search: ${s.addressFields?.length ? s.addressFields.join(", ") : "not supported"}`);
        md.push(`- Verification: ${s.verified ? `✅ ${s.verified}` : "⟨verify at run⟩"}`);
        md.push(`- Coverage: ${s.coverage}`);
        if (s.notes) md.push(`- Notes: ${s.notes}`);
        md.push("");
      }
      md.push("# Identify layers", "");
      for (const l of layers) {
        md.push(`## ${l.id} — ${l.name}`);
        md.push(`- States: ${l.states.join(", ")} · Verification: ${l.verified ? `✅ ${l.verified}` : "⟨verify at run⟩"}${l.url ? "" : " · URL NOT PINNED"}`);
        if (l.notes) md.push(`- Notes: ${l.notes}`);
        md.push("");
      }
      return {
        content: [{ type: "text", text: enforceCharLimit(md.join("\n")) }],
        structuredContent: { sources, identify_layers: layers },
      };
    }
  );
}
