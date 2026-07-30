import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import safetyGuard from "../index";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

type Handler = (event: any, ctx: any) => Promise<any>;

function setup() {
  let handler: Handler | undefined;
  const emitted: Array<[string, unknown]> = [];
  safetyGuard({
    on: (event: string, callback: Handler) => {
      if (event === "tool_call") handler = callback;
    },
    events: { emit: (event: string, data: unknown) => emitted.push([event, data]) },
  } as any);
  return { handler: handler!, emitted };
}

const event = (command: string) => ({ toolName: "bash", input: { command } });

describe("safety guard", () => {
  test("blocks recognized shell deletion commands and directs the agent to safe_rm", async () => {
    const { handler } = setup();
    const ctx = { cwd: "/work/project", hasUI: false };

    for (const command of [
      "rm build.log",
      "rm -rf build",
      "rmdir build",
      "unlink build.log",
      "sudo -u root rm build.log",
      "command -- rm build.log",
      "env -i rm build.log",
      "/usr/bin/env -i /bin/rm build.log",
      "busybox rm build.log",
      "nice -n 10 rm build.log",
      "timeout 2 rm build.log",
      "nohup /bin/rm build.log",
      `sh -c 'rm build.log'`,
      "if true; then /bin/rm build.log; fi",
      "find build -type f -delete",
      "find build -exec rm {} +",
      "printf '%s\\n' build.log | xargs rm",
    ]) {
      const result = await handler(event(command), ctx);
      expect(result.block, command).toBeTrue();
      expect(result.reason, command).toContain("safe_rm");
      expect(result.reason, command).toContain("CRITICAL");
    }
  });

  test("describes the regex command guard as best-effort and does not claim arbitrary code analysis", async () => {
    const { handler } = setup();
    const ctx = { cwd: "/work/project", hasUI: false };

    const recognized = await handler(event("env -i rm build.log"), ctx);
    expect(recognized.reason).toContain("best-effort command policy");
    // The shell scanner is deliberately a heuristic, not a sandbox. Custom
    // destructive tools therefore have to enforce path policy themselves.
    expect(
      await handler(event(`python3 -c "__import__('os').remove('build.log')"`), ctx),
    ).toBeUndefined();
  });

  test("hard-blocks critical commands", async () => {
    const { handler } = setup();
    const result = await handler(event("mkfs /dev/sda"), { cwd: "/work/project", hasUI: false });
    expect(result.block).toBeTrue();
    expect(result.reason).toContain("CRITICAL");
  });

  test("blocks recognized shell deletion registered for background polling", async () => {
    const { handler } = setup();
    const result = await handler(
      { toolName: "background_poll", input: { command: "rm -rf build" } },
      { cwd: "/work/project", hasUI: false },
    );
    expect(result.block).toBeTrue();
    expect(result.reason).toContain("safe_rm");
  });

  test("does not offer a confirmation prompt for shell deletion", async () => {
    const { handler } = setup();
    let confirmed = false;
    const result = await handler(event("rm build.log"), {
      cwd: "/work/project",
      hasUI: true,
      ui: {
        notify: () => undefined,
        confirm: async () => {
          confirmed = true;
          return true;
        },
      },
    });
    expect(result.reason).toContain("safe_rm");
    expect(confirmed).toBeFalse();
  });

  test("guards destructive Git, container, package, and database operations", async () => {
    const { handler } = setup();
    const ctx = { cwd: "/work/project", hasUI: false };

    for (const command of [
      "git push --force origin main",
      "docker system prune -af",
      "npm uninstall important-package",
      'psql -c "DROP TABLE users"',
    ]) {
      const result = await handler(event(command), ctx);
      expect(result.block, command).toBeTrue();
    }
  });

  test("guards protected file reads, writes, and edits", async () => {
    const { handler } = setup();
    const ctx = { cwd: "/work/project", hasUI: false };

    for (const toolName of ["read", "write", "edit"]) {
      const result = await handler({ toolName, input: { path: ".env" } }, ctx);
      expect(result.block, toolName).toBeTrue();
      expect(result.reason).toContain(`Protected file ${toolName}`);
    }

    const atPrefixed = await handler({ toolName: "read", input: { path: "@.env" } }, ctx);
    expect(atPrefixed.block).toBeTrue();
    expect(atPrefixed.reason).toContain("Protected file read");

    expect(
      await handler({ toolName: "read", input: { path: ".env.example" } }, ctx),
    ).toBeUndefined();
  });

  test("resolves symlinks and the nearest existing parent for protected paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "safety-guard-test-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "project");
    const secrets = join(root, ".ssh");
    await mkdir(cwd);
    await mkdir(secrets);
    await writeFile(join(secrets, "config"), "secret");
    await symlink(join(secrets, "config"), join(cwd, "innocent.txt"));
    await symlink(secrets, join(cwd, "linked-secrets"));

    const { handler } = setup();
    const ctx = { cwd, hasUI: false };
    for (const path of ["innocent.txt", "linked-secrets/config", "linked-secrets/new-key.pem"]) {
      const result = await handler({ toolName: "read", input: { path } }, ctx);
      expect(result?.block, path).toBeTrue();
    }
  });

  test("blocks recognized root deletion even in an interactive session", async () => {
    const { handler } = setup();
    let confirmed = false;
    const result = await handler(event("rm -rf /"), {
      cwd: "/work/project",
      hasUI: true,
      ui: {
        notify: () => undefined,
        confirm: async () => {
          confirmed = true;
          return true;
        },
      },
    });

    expect(result.reason).toContain("CRITICAL");
    expect(confirmed).toBeFalse();
  });

  test("reports blocked state while awaiting confirmation", async () => {
    const { handler, emitted } = setup();
    const result = await handler(event("sudo echo ok"), {
      cwd: "/work/project",
      hasUI: true,
      ui: { confirm: async () => false },
    });
    expect(result.block).toBeTrue();
    expect(emitted).toEqual([
      ["herdr:blocked", { active: true, label: "Elevated privileges (sudo)" }],
      ["herdr:blocked", { active: false }],
    ]);
  });
});
