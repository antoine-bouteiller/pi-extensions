import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import askUser from "../src/ask-user/index.js";
import backgroundPoll from "../src/background-poll/index.js";
import claudeCode from "../src/claude-code/index.js";
import commentChecker from "../src/comment-checker/index.js";
import hashline from "../src/hashline/index.js";
import mcp from "../src/mcp/index.js";
import rules from "../src/rules/index.js";
import safeRm from "../src/safe-rm/index.js";
import safetyGuard from "../src/safety-guard/index.js";
import statusPanel from "../src/status-panel/index.js";
import { createFakePi } from "#test-utils/fake-pi";

const entrypoints = {
  askUser,
  backgroundPoll,
  claudeCode,
  commentChecker,
  hashline,
  mcp,
  rules,
  safeRm,
  safetyGuard,
  statusPanel,
};

// Bun runs every test file in a single process. Importing sub-agents here would populate the
// module cache with the real Pi agent directory before src/sub-agents/test/core.test.ts installs
// its mock for it, so that entrypoint is verified in a child process instead.
const ISOLATED_EXTENSIONS = ["sub-agents"];

async function importsExtensionFactory(modulePath: string): Promise<boolean> {
  const script = `
    const { default: extension } = await import(${JSON.stringify("MODULE_PATH")});
    if (typeof extension !== "function") process.exit(1);
  `.replace(JSON.stringify("MODULE_PATH"), JSON.stringify(modulePath));
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  return (await child.exited) === 0;
}

describe("extension entrypoints", () => {
  test("imports every deployed extension", () => {
    for (const [name, entrypoint] of Object.entries(entrypoints)) {
      expect(entrypoint, name).toBeFunction();
    }
  });

  test("every auto-discovered module exports an extension factory", async () => {
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const entries = await readdir(root, { withFileTypes: true });
    const discovered = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(root, entry.name));
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const children = await readdir(join(root, entry.name));
      if (children.includes("index.ts")) discovered.push(join(root, entry.name, "index.ts"));
    }

    expect(discovered.length).toBeGreaterThan(0);
    for (const path of discovered) {
      if (ISOLATED_EXTENSIONS.some((name) => path.includes(`${sep}${name}${sep}`))) {
        expect(await importsExtensionFactory(path), path).toBeTrue();
        continue;
      }
      const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
      expect(module.default, path).toBeFunction();
    }
  });

  test("registers the first-party tools and lifecycle handlers", () => {
    const fixture = createFakePi();
    for (const entrypoint of [
      askUser,
      backgroundPoll,
      claudeCode,
      commentChecker,
      hashline,
      mcp,
      rules,
      safeRm,
      safetyGuard,
      statusPanel,
    ]) {
      entrypoint(fixture.pi);
    }

    expect([...fixture.state.tools.keys()].sort()).toEqual([
      "ask_user",
      "background_poll",
      "hashline_read",
      "hashline_write",
      "mcp",
      "safe_rm",
    ]);
    expect(fixture.state.handlers.has("session_start")).toBeTrue();
    expect(fixture.state.handlers.has("session_shutdown")).toBeTrue();
    expect(fixture.state.handlers.has("tool_call")).toBeTrue();
    expect(fixture.state.handlers.has("tool_result")).toBeTrue();
  });
});
