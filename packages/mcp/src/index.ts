import { createServer } from "node:http";
import { createLogger } from "@3roads/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bonusTools } from "./tools/bonuses.js";
import { searchTools } from "./tools/search.js";
import { setTools } from "./tools/sets.js";
import { tossupTools } from "./tools/tossups.js";

const log = createLogger("mcp");
const MCP_PORT = Number(process.env.MCP_PORT) || 7002;

const server = new McpServer({
  name: "3roads",
  version: "0.0.1",
});

type ToolDef = {
  description: string;
  parameters: { shape: Record<string, unknown> };
  execute: (params: never) => Promise<unknown>;
};

function registerTools(tools: Record<string, ToolDef>) {
  for (const [name, tool] of Object.entries(tools)) {
    server.tool(name, tool.description, tool.parameters.shape, async (params) => {
      log.info(`tool called: ${name}`, params);
      try {
        const result = await tool.execute(params as never);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        log.info(`tool completed: ${name}`);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        log.error(`tool failed: ${name}`, error);
        return {
          content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      }
    });
  }
}

registerTools(tossupTools);
registerTools(bonusTools);
registerTools(setTools);
registerTools(searchTools);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);
  log.debug(`HTTP ${req.method} ${url.pathname}`);

  if (url.pathname === "/mcp") {
    try {
      await server.close();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      log.debug("MCP transport connected");
      await transport.handleRequest(req, res);
    } catch (err) {
      log.error("MCP transport/request failed", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  log.warn(`404 Not Found: ${req.method} ${url.pathname}`);
  res.writeHead(404);
  res.end("Not found");
});

httpServer.on("error", (err) => {
  log.error("HTTP server error", err);
});

httpServer.on("clientError", (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNRESET" || code === "EPIPE") {
    log.debug(`HTTP client disconnected (${code})`);
  } else {
    log.error("HTTP client connection error", err);
  }
});

httpServer.listen(MCP_PORT, "127.0.0.1", () => {
  log.info(`3Roads MCP server running on http://127.0.0.1:${MCP_PORT}/mcp`);
});
