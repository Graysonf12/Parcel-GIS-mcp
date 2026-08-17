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
  /** ISO date last confirmed live, or false = not yet verified ("verify at run") */
  verified: string | false;
  notes?: string;
}

export interface IdentifyLayer {
  id: string;
  name: string;
  url: string;
  states: string[];
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
    verified: "2026-08-17",
    notes:
      "PARCEL_ID formatting varies by county (dashes/dots may be stripped relative to the county PCN). If an exact match fails the server automatically retries as a contains-match; a supplied identifier that still misses should be re-tried with county formatting variants before concluding it is wrong.",
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
    id: "tn-statewide-tdec",
    state: "TN",
    name: "Tennessee statewide parcels (TDEC Parcels_OG mirror)",
    coverage:
      "Statewide TN mirror of Comptroller parcel data hosted by TDEC — candidate primary source for the Chattanooga market. VERIFY AT FIRST TN RUN: returned 403 to one non-browser fetch on 2026-08-17; standard ArcGIS REST queries from this server may still succeed.",
    url: "https://tdeconline.tn.gov/arcgis/rest/services/Parcels_OG/MapServer/0",
    idField: "PARID",
    idAliases: ["PARCELID"],
    addressFields: [],
    fieldMap: {},
    verified: false,
    notes:
      "Layer index and field names unconfirmed. First TN run: gis_raw_query the service root (f=json) to list layers, then the layer root to read fields, then correct this entry. Fallback candidate: Hamilton County's own server at mapsdev.hamiltontn.gov/hcwa03/rest/services/OpenGov/OpenGov_HamiltonTN/MapServer.",
  },
];

export const IDENTIFY_LAYERS: IdentifyLayer[] = [
  {
    id: "ky-jefferson-landuse",
    name: "Jefferson County KY Landuse (LOJIC Open Data)",
    url: "https://gis.lojic.org/maps/rest/services/LojicSolutions/OpenDataDevelopment/MapServer/6",
    states: ["KY"],
    verified: "2026-08-17",
    notes: "Confirmed present in the LOJIC OpenDataDevelopment service listing; attribute schema read at first use. Sibling layers in the same service cover development/zoning-adjacent data — list them with gis_raw_query on the service root.",
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
