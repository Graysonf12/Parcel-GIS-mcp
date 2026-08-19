#!/usr/bin/env node
/**
 * parcel-gis-mcp-server
 *
 * Remote MCP server (streamable HTTP, stateless JSON) exposing county/state
 * parcel data and GIS layer identify queries via public ArcGIS REST services.
 * Third connector in the Hutton SIR Research Agent suite, alongside the FEMA
 * NFHL and Municode connectors.
 *
 * Deploy target: Render web service (GitHub auto-deploy). No API keys needed —
 * every upstream source is a public government endpoint.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { registerTools } from "./tools.js";

function buildServer(): McpServer {
  const server = new McpServer({
    name: "parcel-gis-mcp-server",
    version: "1.1.1",
  });
  registerTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Health check for Render + humans.
app.get("/", (_req, res) => {
  res.json({
    name: "parcel-gis-mcp-server",
    status: "ok",
    mcp_endpoint: "/mcp",
    tools: [
      "parcel_lookup",
      "parcel_search_by_address",
      "gis_layer_identify",
      "gis_elevation_at_point",
      "gis_raw_query",
      "gis_registry_list",
    ],
  });
});

// Stateless streamable HTTP: fresh transport + server per request, JSON responses.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Reject non-POST on /mcp cleanly (stateless server: no GET stream, no sessions).
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. POST JSON-RPC to /mcp." },
    id: null,
  });
});

const port = parseInt(process.env.PORT || "3000", 10);
app.listen(port, () => {
  console.error(`parcel-gis-mcp-server listening on port ${port} (MCP endpoint: POST /mcp)`);
});
