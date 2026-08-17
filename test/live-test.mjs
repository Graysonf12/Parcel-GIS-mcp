// Live smoke test: exercises each tool through the real MCP HTTP endpoint.
// Usage: node test/live-test.mjs [baseUrl]
const BASE = process.argv[2] || "http://localhost:3000/mcp";
let id = 0;

async function rpc(method, params) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  // streamable HTTP may respond as SSE-framed even with enableJsonResponse; handle both
  const jsonText = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("")
    : text;
  return JSON.parse(jsonText);
}

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) return { error: r.error };
  return r.result;
}

function firstText(result) {
  return result?.content?.[0]?.text ?? JSON.stringify(result);
}

const init = await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "live-test", version: "0" },
});
console.log("== initialize:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);

const tools = await rpc("tools/list", {});
console.log("== tools:", tools.result.tools.map((t) => t.name).join(", "));

console.log("\n===== gis_registry_list (FL) =====");
console.log(firstText(await call("gis_registry_list", { state: "FL" })).slice(0, 600));

console.log("\n===== parcel_search_by_address: OSLO / VERO BEACH (fl-statewide) =====");
const addr = await call("parcel_search_by_address", {
  source_id: "fl-statewide", address: "OSLO", city: "VERO BEACH", limit: 2,
});
console.log(firstText(addr).slice(0, 1400));
const flParcelId = addr.structuredContent?.results?.[0]?.attributes?.PARCEL_ID;
const flCentroid = addr.structuredContent?.results?.[0]?.centroid;

console.log("\n===== parcel_lookup:", flParcelId, "(fl-statewide) =====");
const lu = await call("parcel_lookup", { source_id: "fl-statewide", parcel_id: String(flParcelId) });
console.log(firstText(lu).slice(0, 1200));

if (flCentroid) {
  console.log("\n===== gis_elevation_at_point at FL centroid =====");
  console.log(firstText(await call("gis_elevation_at_point", { lon: flCentroid.lon, lat: flCentroid.lat })));
}

console.log("\n===== gis_layer_identify: LOJIC parcels layer @ Bardstown Rd area =====");
const lojicPt = { lon: -85.6521, lat: 38.1889 };
const ident = await call("gis_layer_identify", {
  layer: "https://gis.lojic.org/maps/rest/services/LojicSolutions/OpenDataPVA/MapServer/1",
  ...lojicPt,
});
console.log(firstText(ident).slice(0, 800));
const kyPid = ident.structuredContent?.results?.[0]?.PARCELID;

if (kyPid) {
  console.log("\n===== parcel_lookup:", kyPid, "(ky-jefferson) =====");
  console.log(firstText(await call("parcel_lookup", { source_id: "ky-jefferson", parcel_id: String(kyPid) })).slice(0, 900));
}

console.log("\n===== gis_layer_identify: ky-jefferson-landuse (registered) @ same point =====");
console.log(firstText(await call("gis_layer_identify", { layer: "ky-jefferson-landuse", ...lojicPt })).slice(0, 700));

console.log("\n===== gis_raw_query: TDEC TN parcels service root (verify-at-run probe) =====");
console.log(firstText(await call("gis_raw_query", {
  url: "https://tdeconline.tn.gov/arcgis/rest/services/Parcels_OG/MapServer",
  params: { f: "json" },
})).slice(0, 500));

console.log("\n===== error handling: bad source id =====");
console.log(firstText(await call("parcel_lookup", { source_id: "nope", parcel_id: "123" })));

console.log("\nDONE");
