/**
 * Jurisdiction endpoint registry for parcel-gis-mcp-server.
 *
 * This file is the code-side mirror of the Hutton Jurisdiction Portal Registry:
 * coverage grows by adding an entry here, not by writing new code.
 *
 * `verified` carries the date the endpoint was last confirmed live, or false
 * for entries that still need their first live check ("verify at run" in
 * Portal Registry terms). Tools surface this so an agent knows how much to
 * trust an entry before citing it.
 */

export interface FieldMap {
  /** Owner name field(s) */
  owner?: string[];
  /** Situs / physical address field(s), in display order */
  situsAddress?: string[];
  city?: string;
  zip?: string;
  /** Acreage or area field plus its unit */
  area?: { field: string; unit: "acres" | "sqft" | "sqm" };
  /** Land-use / DOR use code field(s) */
  useCode?: string[];
  legal?: string;
  /** Assessed / just value field */
  value?: string;
  /** Most-recent sale price / year fields */
  salePrice?: string;
  saleYear?: string;
}

export interface ParcelSource {
  /** Registry key used in tool calls, e.g. "fl-statewide" */
  id: string;
  state: string;
  name: string;
  coverage: string;
  /** Full ArcGIS REST layer URL (ends in the layer index) */
  url: string;
  /** Primary parcel-identifier field (the §0A primary key) */
  idField: string;
  /** Alternate identifier fields worth trying (PIN, LRSN, alt key...) */
  idAliases?: string[];
  /** Field(s) usable for address search; empty = address search unsupported */
  addressFields?: string[];
  fieldMap: FieldMap;
  /**
   * Layer's native wkid, set ONLY when the server silently ignores WGS84
   * input geometry (returns zero features, no error) and points must be
   * projected client-side before spatial queries (see projections.ts).
   */
  nativeSr?: number;
  /**
   * True when SQL LIKE/attribute scans reliably time out on this layer
   * (very large hosted layers). The address-search SQL fallback is skipped
   * with an explanatory message instead of burning the timeout budget.
   * Live-measured on fl-statewide 2026-08: point-intersects ~2s, but LIKE,
   * envelope, and distance queries ALL time out — only point queries and
   * exact attribute equality are fast.
   */
  slowSql?: boolean;
  /** ISO date last confirmed live, or false = not yet verified ("verify at run") */
  verified: string | false;
  notes?: string;
}

export interface IdentifyLayer {
  id: string;
  name: string;
  url: string;
  states: string[];
  /** Same semantics as ParcelSource.nativeSr */
  nativeSr?: number;
  verified: string | false;
  notes?: string;
}

export const PARCEL_SOURCES: ParcelSource[] = [
  {
    id: "fl-statewide",
    state: "FL",
    name: "Florida Statewide Parcels (FGIO / FDOR Cadastral)",
    coverage:
      "All 67 Florida counties — covers IRC, Sumter/Wildwood, Palm Beach, Orange, St. Johns, Charlotte and every other FL market in one layer. Annual FDOR NAL roll; check the layer description for the current roll year and note data age per Quality Rule 5.",
    url: "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0",
    idField: "PARCEL_ID",
    idAliases: [],
    addressFields: ["PHY_ADDR1"],
    fieldMap: {
      owner: ["OWN_NAME"],
      situsAddress: ["PHY_ADDR1", "PHY_ADDR2"],
      city: "PHY_CITY",
      zip: "PHY_ZIPCD",
      area: { field: "LND_SQFOOT", unit: "sqft" },
      useCode: ["DOR_UC", "PA_UC"],
      legal: "S_LEGAL",
      value: "JV",
      salePrice: "SALE_PRC1",
      saleYear: "SALE_YR1",
    },
    slowSql: true,
    verified: "2026-08-17",
    notes:
      "PARCEL_ID formatting varies by county (dashes/dots may be stripped relative to the county PCN). If an exact match fails the server automatically retries as a contains-match; a supplied identifier that still misses should be re-tried with county formatting variants before concluding it is wrong. LIVE FINDINGS 2026-08: only POINT-intersects (~2s) and exact attribute equality are fast on this 10M-row layer — LIKE, envelope, and distance queries all time out (hence slowSql + the probe-ring address strategy). No ROW parcels in this layer: an address point in the street returns zero features, which is what the probe ring exists to solve (proven: 100 N Main St Wildwood → 28m-east probe → G06L124).",
  },
  {
    id: "ky-jefferson",
    state: "KY",
    name: "Jefferson County KY Parcels (LOJIC Open Data — OpenDataPVA)",
    coverage:
      "Louisville / Jefferson County Metro. This is LOJIC's OPEN server (gis.lojic.org/maps) — no token required, unlike the apps.lojic.org service logged as blocked in the Portal Registry.",
    url: "https://gis.lojic.org/maps/rest/services/LojicSolutions/OpenDataPVA/MapServer/1",
    idField: "PARCELID",
    idAliases: ["PIN", "LRSN"],
    addressFields: [],
    fieldMap: {},
    verified: "2026-08-17",
    notes:
      "Geometry + identifiers only (PARCELID, PIN, LRSN) — no owner/address/value attributes on this layer. Use it to resolve the parcel polygon, centroid, and premise geometry from a supplied PARCELID, then pull the full card from LOJIC Online (already ✅ in the Portal Registry). Companion open layers under LojicSolutions/OpenDataDevelopment (e.g. layer 6 = Jefferson County KY Landuse) work with gis_layer_identify.",
  },
  {
    id: "ky-state-pva-pattern",
    state: "KY",
    name: "Kentucky per-county PVA parcels (kygisserver pattern)",
    coverage:
      "Only SOME Kentucky counties — the state server hosts services named Ky_PVA_<County>_Parcels_WGS84WM. Webster is confirmed present; Jefferson and Scott are confirmed ABSENT (2026-08-17). Probe for the target county with gis_raw_query against the WGS84WM_Services folder before relying on this.",
    url: "https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_PVA_Webster_Parcels_WGS84WM/MapServer/0",
    idField: "PARCELID",
    idAliases: [],
    addressFields: [],
    fieldMap: {},
    verified: false,
    notes:
      "Template entry — swap the county name in the URL. Field names unconfirmed; run gis_raw_query on the layer root (f=json) to read the schema at first use, then promote a real entry into this registry.",
  },
  {
    id: "tn-hamilton",
    state: "TN",
    name: "Hamilton County TN Parcels (OpenGov integration service)",
    coverage:
      "Hamilton County / Chattanooga market — the home market. Full assessment card on the layer: owner, situs address, calc acreage, land use code, land/building/appraised/assessed values, four sale records with book/page, district, legal description.",
    url: "https://mapsdev.hamiltontn.gov/hcwa03/rest/services/OpenGov/OpenGov_HamiltonTN/MapServer/2",
    idField: "TAX_MAP_NO",
    idAliases: ["GISLINK", "PBA_NUM"],
    addressFields: ["ADDRESS"],
    fieldMap: {
      owner: ["OWNERNAME1", "OWNERNAME2"],
      situsAddress: ["ADDRESS"],
      area: { field: "CALCACRES", unit: "acres" },
      useCode: ["LUCODE", "PROPTYPE", "CURRENTUSE"],
      legal: "LEGALDESC1",
      value: "APPVALUE",
      salePrice: "SALE1CONSD",
    },
    nativeSr: 103152,
    verified: "2026-08-17",
    notes:
      "CRITICAL QUIRK (confirmed live 2026-08-17): this server SILENTLY IGNORES WGS84 input geometry — a 4326 point query returns zero features with no error. The connector projects points to TN State Plane (ftUS) client-side; native-SR queries confirmed working. TAX_MAP_NO uses internal padding (e.g. '073  117.09') — the LIKE fallback in parcel_lookup absorbs this; also same data splits across MAP/GROUP_/PARCEL fields. Host is 'mapsdev' (a dev-named box that serves production data for the OpenGov integration) — if it ever disappears, look for the production hostname on hamiltontn.gov. Sibling layers: 18=RPA Zoning, 19=Municipalities, 3=Water Quality Program Boundary, 7/8/9=FEMA floodway/100yr/500yr.",
  },
  {
    id: "tn-statewide-tdec",
    state: "TN",
    name: "Tennessee statewide parcels (TDEC Parcels_OG mirror) — BLOCKED",
    coverage:
      "Statewide TN mirror of Comptroller parcel data hosted by TDEC. ❌ CONFIRMED BLOCKED 2026-08-17: returns HTTP 403 to non-browser clients, verified from both a sandbox client and the deployed connector. Kept as a reference entry only — use tn-hamilton for the Chattanooga market and probe per-county servers elsewhere in TN.",
    url: "https://tdeconline.tn.gov/arcgis/rest/services/Parcels_OG/MapServer/0",
    idField: "PARID",
    idAliases: ["PARCELID"],
    addressFields: [],
    fieldMap: {},
    verified: false,
    notes:
      "Do not spend retries here — the 403 is bot-blocking at the host level, the Portal-Registry ❌ pattern. Logged in the Jurisdiction Portal Registry 2026-08-17.",
  },
];

export const IDENTIFY_LAYERS: IdentifyLayer[] = [
  {
    id: "ky-jefferson-landuse",
    name: "Jefferson County KY Landuse (LOJIC Open Data)",
    url: "https://gis.lojic.org/maps/rest/services/LojicSolutions/OpenDataDevelopment/MapServer/6",
    states: ["KY"],
    verified: "2026-08-17",
    notes: "CONFIRMED WORKING live 2026-08-17 (returned LANDUSE_CODE/LANDUSE_NAME/ACRES at a Bardstown Rd test point). Sibling layers in the same service cover development/zoning-adjacent data — list them with gis_raw_query on the service root.",
  },
  {
    id: "tn-hamilton-zoning-rpa",
    name: "Hamilton County TN — RPA Zoning (Chattanooga regional planning)",
    url: "https://mapsdev.hamiltontn.gov/hcwa03/rest/services/OpenGov/OpenGov_HamiltonTN/MapServer/18",
    states: ["TN"],
    nativeSr: 103152,
    verified: false,
    notes: "Same server/quirk as tn-hamilton (client-side projection applied automatically). Sibling zoning layers: 11=Collegedale, 13=Red Bank, 14=Soddy Daisy, 17=Special Permits, 16=pre-2002 cases.",
  },
  {
    id: "tn-hamilton-municipalities",
    name: "Hamilton County TN — Municipal boundaries (incorporation check)",
    url: "https://mapsdev.hamiltontn.gov/hcwa03/rest/services/OpenGov/OpenGov_HamiltonTN/MapServer/19",
    states: ["TN"],
    nativeSr: 103152,
    verified: false,
    notes: "City-limits determination for the Chattanooga market (which municipal code governs). Same projection quirk handled automatically.",
  },
  {
    id: "tn-hamilton-water-quality",
    name: "Hamilton County TN — Water Quality Program Boundary",
    url: "https://mapsdev.hamiltontn.gov/hcwa03/rest/services/OpenGov/OpenGov_HamiltonTN/MapServer/3",
    states: ["TN"],
    nativeSr: 103152,
    verified: false,
    notes: "Directly relevant to the Stormwater Routine's TN framework (City of Chattanooga Water Quality program layer). Same projection quirk handled automatically.",
  },
  {
    id: "fl-wmd-boundaries",
    name: "Florida Water Management District boundaries",
    url: "",
    states: ["FL"],
    verified: false,
    notes:
      "URL not yet pinned — needed for the Orange County SJRWMD/SFWMD split check. Locate the authoritative layer on geodata.floridagio.gov (FGIO) or an individual WMD's ArcGIS server at first use, verify with gis_raw_query, then fill in this entry.",
  },
  {
    id: "fl-municipal-boundaries",
    name: "Florida municipal boundaries (incorporation check)",
    url: "",
    states: ["FL"],
    verified: false,
    notes:
      "URL not yet pinned — needed for Village-LDC-vs-county-code calls (Royal Palm Beach / Palm Springs pattern). Locate on FGIO at first use and fill in.",
  },
];

export function getParcelSource(id: string): ParcelSource | undefined {
  return PARCEL_SOURCES.find((s) => s.id === id);
}

export function getIdentifyLayer(id: string): IdentifyLayer | undefined {
  return IDENTIFY_LAYERS.find((l) => l.id === id);
}
