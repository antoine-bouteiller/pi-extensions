// oxlint-disable-next-line effecttsgo/node-builtin-import -- This standalone child process writes its PID marker before any application Effect runtime exists.
import { writeFile } from 'node:fs/promises'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'pi-mcp-test-fixture', version: '1.0.0' })
server.registerTool(
  'echo.fixture',
  {
    description: 'Echo a fixture value',
    inputSchema: { value: z.string() },
  },
  async ({ value }) => ({
    content: [{ text: `fixture:${value}`, type: 'text' }],
    structuredContent: { echoed: value },
  })
)

const marker = process.env.PI_MCP_FIXTURE_PID
if (marker !== undefined) {
  await writeFile(marker, String(process.pid), { mode: 0o600 })
}
await server.connect(new StdioServerTransport())
