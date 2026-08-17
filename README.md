# parcel-gis-mcp-server

Third connector in the Hutton SIR Research Agent suite (alongside the FEMA NFHL
and Municode connectors). Exposes county/state **parcel data** and **GIS layer
identify** queries by hitting public government **ArcGIS REST services
directly** — the same "bypass the JS portal, query the service underneath"
pattern that made the FEMA connector work.

No API keys. Every upstream source is a public endpoint.

## What it solves

The single most consistent failure class in SIR runs: Tier-1 parcel portals
(qPublic/Schneider, pbcpao.gov, OCPA, LOJIC apps) are JS-rendered or
token-blocked, and the only Tier-2 mirror (FloridaParcels) is FL-only and
unreliable. This server resolves the SIR §0A primary key — the parcel
identifier — against the open ArcGIS layers those portals sit on top of, and
adds point-in-polygon lookups (zoning district, land use, WMD, city limits)
plus USGS elevation.

## Tools

| Tool | Purpose |
|---|---|
| `parcel_lookup` | Parcel by identifier (§0A primary key) → attributes + WGS84 centroid. Exact → LIKE → alias-field fallback. |
| `parcel_search_by_address` | §0A(5) fallback path when no identifier was supplied. |
| `gis_layer_identify` | Point-in-polygon against a registered layer **or any ArcGIS layer URL** — zoning district, land use, municipal boundary, WMD split checks. |
| `gis_elevation_at_point` | USGS EPQS/3DEP ground elevation (SIR topography path 1, Quality Rule 8). |
| `gis_raw_query` | Escape hatch (mirrors `municode_raw_get`): list services, read layer schemas, hand-built queries — how new jurisdictions get onboarded. |
| `gis_registry_list` | Show all registered sources/layers with verification status. |

The centroid from `parcel_lookup` chains directly into the FEMA connector
(`fema_flood_zone_lookup`) and `gis_elevation_at_point` — parcel ID in, flood
zone + elevation out, with coordinates carried per Quality Rule 8.

## The registry (src/registry.ts)

Coverage grows by **adding a registry entry, not writing code** — the code-side
mirror of the Jurisdiction Portal Registry. Every entry carries a `verified`
date or `false` (= ⟨verify at run⟩). Shipped seed:

- `fl-statewide` — FGIO/FDOR cadastral, all 67 FL counties (✅ verified 2026-08-17; schema confirmed: PARCEL_ID, OWN_NAME, PHY_ADDR1, LND_SQFOOT, DOR_UC, S_LEGAL, SALE_*, JV)
- `ky-jefferson` — LOJIC **open** OpenDataPVA parcels (✅ verified 2026-08-17 — the open server at gis.lojic.org, not the token-blocked apps.lojic.org one; geometry + PARCELID/PIN/LRSN only)
- `ky-state-pva-pattern` — kygisserver per-county PVA template (⟨verify at run⟩; Webster confirmed present, Jefferson/Scott confirmed absent)
- `tn-statewide-tdec` — TDEC statewide parcels mirror for the Chattanooga market (⟨verify at run⟩; returned 403 to one non-browser client 2026-08-17)
- Identify layers: `ky-jefferson-landuse` (✅ listed), `fl-wmd-boundaries` + `fl-municipal-boundaries` (URL to pin at first use)

**Onboarding a new jurisdiction:** `gis_raw_query` the county's
`/rest/services` directory → find the parcel/zoning layer → read its field
schema (`f=json` on the layer root) → add a `ParcelSource`/`IdentifyLayer`
entry → commit → Render auto-deploys.

## Local development

```bash
npm install
npm run build
npm start                      # listens on :3000, MCP endpoint = POST /mcp
node test/live-test.mjs        # smoke test against localhost
```

Note: from inside a sandboxed/proxied environment outbound calls may be
blocked; run the smoke test against the deployed URL instead:

```bash
node test/live-test.mjs https://YOUR-SERVICE.onrender.com/mcp
```

## Deploy (GitHub → Render)

Same process as the FEMA and Municode connectors — see `DEPLOYMENT.md` for the
full step-by-step. Short version: push this repo to GitHub → Render "New Web
Service" from the repo → build `npm install && npm run build`, start
`npm start` → connector URL is `https://<service>.onrender.com/mcp`.
