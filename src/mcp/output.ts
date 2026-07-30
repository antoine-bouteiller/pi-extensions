import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GatewayContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface BoundedOutputDetails {
  truncated: boolean;
  fullOutputPath?: string;
  outputLines?: number;
  totalLines?: number;
  outputBytes?: number;
  totalBytes?: number;
}

export interface BoundedOutput {
  content: GatewayContent[];
  details: BoundedOutputDetails;
}

/**
 * Bounds only model-visible text. Images remain native Pi image blocks and the
 * complete text is written to a private temporary file when truncation occurs.
 */
export async function boundGatewayOutput(content: GatewayContent[]): Promise<BoundedOutput> {
  const textBlocks = content.filter(
    (block): block is Extract<GatewayContent, { type: "text" }> => block.type === "text",
  );
  const completeText = textBlocks.map((block) => block.text).join("\n");
  const initial = truncateHead(completeText, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!initial.truncated) return { content, details: { truncated: false } };

  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-"));
  const fullOutputPath = join(directory, "output.txt");
  await writeFile(fullOutputPath, completeText, { encoding: "utf8", mode: 0o600 });

  // Reserve enough room for the notice (including the private temp path) so the
  // final model-visible text, not merely the retained payload, stays in Pi's limits.
  const truncation = truncateHead(completeText, {
    maxBytes: DEFAULT_MAX_BYTES - 2048,
    maxLines: DEFAULT_MAX_LINES - 4,
  });
  const notice =
    `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
    `Full output saved to: ${fullOutputPath}]`;
  const visibleText = truncation.content + notice;
  if (
    Buffer.byteLength(visibleText, "utf8") > DEFAULT_MAX_BYTES ||
    visibleText.split("\n").length > DEFAULT_MAX_LINES
  ) {
    throw new Error("Could not safely bound MCP tool output");
  }
  const images = content.filter(
    (block): block is Extract<GatewayContent, { type: "image" }> => block.type === "image",
  );

  return {
    content: [{ type: "text", text: visibleText }, ...images],
    details: {
      truncated: true,
      fullOutputPath,
      outputLines: truncation.outputLines,
      totalLines: truncation.totalLines,
      outputBytes: truncation.outputBytes,
      totalBytes: truncation.totalBytes,
    },
  };
}
