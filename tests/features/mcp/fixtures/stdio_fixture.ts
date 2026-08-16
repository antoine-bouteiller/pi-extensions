import { NodeFileSystem } from '@effect/platform-node'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Effect, FileSystem } from 'effect'
import { z } from 'zod'

const server = new McpServer({ name: 'pi-mcp-test-fixture', version: '1.0.0' })
server.registerTool(
  'echo.fixture',
  {
    description: 'Echo a fixture value',
    inputSchema: { value: z.string() },
  },
  ({ value }) => ({
    content: [{ text: `fixture:${value}`, type: 'text' }],
    structuredContent: { echoed: value },
  })
)

const marker = process.env.PI_MCP_FIXTURE_PID
if (marker !== undefined) {
  await FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(marker, String(process.pid), { mode: 0o600 })),
    Effect.provide(NodeFileSystem.layer),
    Effect.runPromise
  )
}
await server.connect(new StdioServerTransport())
