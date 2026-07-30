import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TurndownService from "turndown";
import { Type, type Static } from "typebox";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

const WebfetchParams = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
  format: Type.Optional(
    StringEnum(["markdown", "text", "html"] as const, {
      description: "Output format for HTML responses. Defaults to markdown.",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS} and is capped at ${MAX_TIMEOUT_SECONDS}.`,
    }),
  ),
});

export type WebfetchInput = Static<typeof WebfetchParams>;
type WebfetchFormat = NonNullable<WebfetchInput["format"]>;

export interface WebfetchDetails {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  downloadedBytes: number;
  timeoutSeconds: number;
  format: WebfetchFormat;
  converted: boolean;
  outputTruncated: boolean;
  outputBytes: number;
  fullOutputPath?: string;
}

export type WebfetchFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface WebfetchDependencies {
  fetch: WebfetchFetch;
  saveFullOutput(content: string): Promise<string>;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(Math.ceil(value), MAX_TIMEOUT_SECONDS);
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`webfetch only supports HTTP and HTTPS URLs: ${value}`);
  }
  return url;
}

function isHtml(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function turndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  service.remove(["script", "style", "noscript", "template", "form"]);
  return service;
}

function articleHtml(html: string): string {
  for (const tag of ["article", "main", "body"] as const) {
    const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (match?.[1]) return match[1];
  }
  return html;
}

function pageTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return undefined;
  const title = turndown().turndown(match[1]).replace(/\s+/g, " ").trim();
  return title || undefined;
}

function htmlToMarkdown(html: string): string {
  const title = pageTitle(html);
  const content = turndown()
    .turndown(articleHtml(html))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!title) return content;
  const titleHeading = `# ${title}`;
  return content.startsWith(titleHeading) ? content : `${titleHeading}\n\n${content}`.trim();
}

function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-+*])[ \t]+/gm, "")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/^[ \t]*[-*_](?:[ \t]*[-*_]){2,}[ \t]*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function convertHtml(html: string, format: WebfetchFormat): string {
  if (format === "html") return html;
  const markdown = htmlToMarkdown(html);
  return format === "text" ? markdownToText(markdown) : markdown;
}

async function readLimitedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Response is too large: ${formatSize(declaredLength)} exceeds the ${formatSize(MAX_DOWNLOAD_BYTES)} download limit`,
    );
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("webfetch was cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(
          `Response is too large: it exceeds the ${formatSize(MAX_DOWNLOAD_BYTES)} download limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function defaultSaveFullOutput(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
  const path = join(directory, "output.txt");
  await withFileMutationQueue(path, () => writeFile(path, content, "utf8"));
  return path;
}

async function fetchResult(
  params: WebfetchInput,
  externalSignal: AbortSignal | undefined,
  onUpdate: ((result: AgentToolResult<unknown>) => void) | undefined,
  dependencies: WebfetchDependencies,
): Promise<AgentToolResult<WebfetchDetails>> {
  const url = parseUrl(params.url);
  const format = params.format ?? "markdown";
  const timeoutSeconds = normalizeTimeout(params.timeout);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () =>
    controller.abort(externalSignal?.reason ?? new Error("webfetch was cancelled"));
  externalSignal?.addEventListener("abort", cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`webfetch timed out after ${timeoutSeconds}s`));
  }, timeoutSeconds * 1_000);

  onUpdate?.({
    content: [
      {
        type: "text",
        text: `Fetching ${url.href} as ${format} (timeout ${timeoutSeconds}s)...`,
      },
    ],
    details: {},
  });

  try {
    const response = await dependencies.fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept:
          format === "html"
            ? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
            : "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
        "user-agent": "pi-webfetch/1.0",
      },
    });
    const body = await readLimitedBody(response, controller.signal);
    const decoded = new TextDecoder().decode(body);
    const contentType = response.headers.get("content-type") ?? "";
    const converted = isHtml(contentType) && format !== "html";
    const completeOutput = isHtml(contentType) ? convertHtml(decoded, format) : decoded;
    const truncation = truncateHead(completeOutput, {
      maxBytes: MAX_OUTPUT_BYTES,
      maxLines: MAX_OUTPUT_LINES,
    });

    let output = truncation.content;
    let fullOutputPath: string | undefined;
    if (truncation.truncated) {
      fullOutputPath = await dependencies.saveFullOutput(completeOutput);
      output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
    }

    const details: WebfetchDetails = {
      url: url.href,
      finalUrl: response.url || url.href,
      status: response.status,
      statusText: response.statusText,
      contentType,
      downloadedBytes: body.byteLength,
      timeoutSeconds,
      format,
      converted,
      outputTruncated: truncation.truncated,
      outputBytes: truncation.outputBytes,
      ...(fullOutputPath ? { fullOutputPath } : {}),
    };
    return { content: [{ type: "text", text: output }], details };
  } catch (error) {
    if (timedOut) throw new Error(`webfetch timed out after ${timeoutSeconds}s`);
    if (externalSignal?.aborted) throw new Error("webfetch was cancelled");
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", cancel);
  }
}

export function createWebfetchExtension(
  overrides: Partial<WebfetchDependencies> = {},
): (pi: ExtensionAPI) => void {
  const dependencies: WebfetchDependencies = {
    fetch: overrides.fetch ?? globalThis.fetch.bind(globalThis),
    saveFullOutput: overrides.saveFullOutput ?? defaultSaveFullOutput,
  };

  return function webfetchExtension(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "webfetch",
      label: "Web Fetch",
      description: `Fetch an HTTP(S) URL and return its content as markdown, plain text, or raw HTML. HTML defaults to markdown. Downloads are limited to ${formatSize(MAX_DOWNLOAD_BYTES)}; output is truncated to ${MAX_OUTPUT_LINES} lines or ${formatSize(MAX_OUTPUT_BYTES)} and saved to a temporary file when larger.`,
      promptSnippet: "Fetch and read static web pages or HTTP endpoints",
      promptGuidelines: [
        "Use webfetch to read a known static web page or HTTP endpoint. Use agent-browser instead when the task requires interaction, authentication, screenshots, or JavaScript-rendered content.",
      ],
      parameters: WebfetchParams,
      async execute(_toolCallId, params, signal, onUpdate) {
        return fetchResult(params, signal, onUpdate, dependencies);
      },
    });
  };
}

export default createWebfetchExtension();
