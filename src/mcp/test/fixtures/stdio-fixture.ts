import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile } from "node:fs/promises";
import { z } from "zod";

const server = new McpServer({ name: "pi-mcp-test-fixture", version: "1.0.0" });
server.registerTool(
  "echo.fixture",
  {
    description: "Echo a fixture value",
    inputSchema: { value: z.string() },
  },
  async ({ value }) => ({
    content: [{ type: "text", text: `fixture:${value}` }],
    structuredContent: { echoed: value },
  }),
);

const marker = process.env.PI_MCP_FIXTURE_PID;
if (marker) await writeFile(marker, String(process.pid), { mode: 0o600 });
await server.connect(new StdioServerTransport());
