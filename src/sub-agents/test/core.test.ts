import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const TEST_AGENT_DIR = "/tmp/pi-codex-subagents-tests";
const FAKE_RPC_CHILD = path.join(import.meta.dir, "fixtures", "fake-rpc-child.js");
process.env.PI_SUBAGENT_TEMP_DIR = path.join(TEST_AGENT_DIR, "temp");

const codingAgent = await import("@earendil-works/pi-coding-agent");
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...codingAgent,
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => TEST_AGENT_DIR,
}));

const {
  AgentManager,
  RpcJsonlDecoder,
  consumeFirstMatchingMailboxEvent,
  getAgent,
  getRunsDir,
  getSocketPath,
  parentScopeKey,
  taskStorageKey,
} = await import("../core.js");
const { SubagentPeekOverlay } = await import("../peek.js");

function createAgentManager(options: Record<string, unknown> = {}) {
  return new AgentManager({
    piCommand: { command: FAKE_RPC_CHILD },
    ...options,
  });
}

function processTest(name: string, run: () => void | Promise<void>): void {
  test(name, run, 15_000);
}

describe("RPC framing", () => {
  test("splits only on LF and preserves Unicode line separators", () => {
    const decoder = new RpcJsonlDecoder();
    const payload = JSON.stringify({ text: "before\u2028after" });
    expect(decoder.push(Buffer.from(payload.slice(0, 7)))).toEqual([]);
    expect(decoder.push(Buffer.from(`${payload.slice(7)}\n`))).toEqual([payload]);
    expect(decoder.end()).toEqual([]);
  });
});

describe("session-scoped identities", () => {
  test("separates parent sessions and formerly colliding task names", () => {
    expect(parentScopeKey("parent-a")).not.toBe(parentScopeKey("parent-b"));
    expect(taskStorageKey("review/api")).not.toBe(taskStorageKey("review__api"));
  });
});

describe("run storage", () => {
  const packageDir = path.join(TEST_AGENT_DIR, "pi-codex-subagents");
  const configFile = path.join(packageDir, "config.json");
  const fixtureDir = path.join(TEST_AGENT_DIR, "retention-fixture");

  test("uses persistent package storage by default", () => {
    fs.rmSync(configFile, { force: true });
    expect(getRunsDir()).toBe(path.join(packageDir, "runs"));
  });

  test("keeps legacy temporary runs discoverable", () => {
    fs.rmSync(configFile, { force: true });
    const parentSessionId = "legacy-parent";
    const id = "11111111-1111-4111-8111-111111111111";
    const legacyRoot = path.join(
      process.env.PI_SUBAGENT_TEMP_DIR!,
      "pi-codex-subagents",
      os.userInfo().username,
      "runs",
    );
    const legacyScope = path.join(legacyRoot, parentScopeKey(parentSessionId));
    fs.mkdirSync(legacyScope, { recursive: true });
    fs.writeFileSync(
      path.join(legacyScope, `${id}.info.json`),
      JSON.stringify({
        id,
        taskName: "legacy",
        status: "closed",
        finalResponse: "legacy response",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    expect(getAgent("legacy", parentSessionId)).toMatchObject({
      id,
      status: "completed",
      finalResponse: "legacy response",
    });
    fs.rmSync(legacyScope, { recursive: true, force: true });
  });

  test("keeps agent lists in creation order when activity changes", async () => {
    fs.rmSync(configFile, { force: true });
    const parentSessionId = "creation-order";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const now = Date.now();
    const agents = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        taskName: "older",
        createdAt: now - 2000,
        lastActivity: now,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        taskName: "newer",
        createdAt: now - 1000,
        lastActivity: now - 1000,
      },
    ];
    fs.mkdirSync(scope, { recursive: true });
    for (const agent of agents) {
      fs.writeFileSync(
        path.join(scope, `${agent.id}.info.json`),
        JSON.stringify({
          ...agent,
          canonicalName: `/${agent.taskName}`,
          parentSessionId,
          status: "completed",
          updatedAt: agent.lastActivity,
        }),
      );
    }

    const manager = createAgentManager();
    try {
      expect(
        manager.listAgents(undefined, parentSessionId).map((agent) => agent.agent_name),
      ).toEqual(["/newer", "/older"]);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test("removes expired runs and outputs using configurable retention", () => {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 3 }));

    const now = Date.now();
    const oldTime = new Date(now - 4 * 24 * 60 * 60 * 1000);
    const scope = path.join(fixtureDir, "a".repeat(24));
    const unrelatedScope = path.join(fixtureDir, "unrelated");
    const outputs = path.join(fixtureDir, "_outputs");
    const expiredId = "11111111-1111-4111-8111-111111111111";
    const activeId = "22222222-2222-4222-8222-222222222222";
    const expiredInfo = path.join(scope, `${expiredId}.info.json`);
    const activeInfo = path.join(scope, `${activeId}.info.json`);
    const expiredOutput = path.join(
      outputs,
      `${oldTime.getTime()}-33333333-3333-4333-8333-333333333333.txt`,
    );
    const activeMarker = path.join(
      process.env.PI_SUBAGENT_TEMP_DIR!,
      "pi-codex-subagents",
      os.userInfo().username,
      "sockets",
      `${activeId}.peek.json`,
    );
    const unrelatedAgentFile = path.join(scope, `${expiredId}.notes`);
    const staleLock = path.join(scope, `.task-${"c".repeat(24)}.lock`);
    const liveOwnerLock = path.join(scope, `.task-${"d".repeat(24)}.lock`);

    try {
      fs.mkdirSync(scope, { recursive: true });
      fs.mkdirSync(unrelatedScope, { recursive: true });
      fs.mkdirSync(outputs, { recursive: true });
      fs.mkdirSync(path.dirname(activeMarker), { recursive: true });
      for (const [file, id] of [
        [expiredInfo, expiredId],
        [activeInfo, activeId],
      ]) {
        fs.writeFileSync(
          file,
          JSON.stringify({
            id,
            createdAt: oldTime.getTime(),
            updatedAt: oldTime.getTime(),
            lastActivity: oldTime.getTime(),
          }),
        );
        fs.utimesSync(file, oldTime, oldTime);
      }
      fs.writeFileSync(
        activeMarker,
        JSON.stringify({ pid: process.pid, startedAt: now, token: "test" }),
      );
      fs.writeFileSync(unrelatedAgentFile, "keep");
      fs.writeFileSync(staleLock, "");
      fs.writeFileSync(liveOwnerLock, JSON.stringify({ pid: process.pid }));
      fs.utimesSync(staleLock, oldTime, oldTime);
      fs.utimesSync(liveOwnerLock, oldTime, oldTime);
      fs.writeFileSync(expiredOutput, "old");
      fs.utimesSync(expiredOutput, oldTime, oldTime);
      fs.writeFileSync(path.join(outputs, "unrelated.txt"), "keep");
      fs.writeFileSync(path.join(unrelatedScope, "unrelated.txt"), "keep");

      createAgentManager();
      expect(fs.existsSync(expiredInfo)).toBe(false);
      expect(fs.existsSync(activeInfo)).toBe(true);
      expect(fs.existsSync(unrelatedAgentFile)).toBe(true);
      expect(fs.existsSync(staleLock)).toBe(false);
      expect(fs.existsSync(liveOwnerLock)).toBe(true);
      expect(fs.existsSync(expiredOutput)).toBe(false);
      expect(fs.existsSync(path.join(outputs, "unrelated.txt"))).toBe(true);
      expect(fs.existsSync(path.join(unrelatedScope, "unrelated.txt"))).toBe(true);

      fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 0 }));
      fs.writeFileSync(expiredInfo, "{}");
      fs.utimesSync(expiredInfo, oldTime, oldTime);
      createAgentManager();
      expect(fs.existsSync(expiredInfo)).toBe(true);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(activeMarker, { force: true });
      fs.rmSync(configFile, { force: true });
    }
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE_MODELS = [
  { provider: "openai", id: "gpt-5.6-luna" },
  { provider: "openai", id: "gpt-5.6-sol" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "anthropic", id: "claude-opus-5" },
];

function spawnParams(parentSessionId: string, task_name: string, message: string) {
  return {
    task_name,
    message,
    agent_type: "implementer" as const,
    cwd: TEST_AGENT_DIR,
    parentSessionId,
    availableModels: AVAILABLE_MODELS,
    parentModel: { provider: "openai", id: "gpt-5.6-sol" },
  };
}

describe("child process lifecycle", () => {
  processTest("resolves profiles before creating task artifacts", async () => {
    const parentSessionId = "unavailable-profile-model";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const manager = createAgentManager();
    try {
      await expect(
        manager.spawnAgent({
          ...spawnParams(parentSessionId, "worker", "must not start"),
          availableModels: AVAILABLE_MODELS.filter((model) => model.id !== "claude-sonnet-5"),
        }),
      ).rejects.toThrow("not authenticated or available");
      expect(fs.existsSync(scope)).toBe(false);
    } finally {
      await manager.shutdown();
    }
  });

  processTest("passes read-only profile metadata without changing the task message", async () => {
    const parentSessionId = "readonly-profile-metadata";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const manager = createAgentManager();
    try {
      await manager.spawnAgent({
        ...spawnParams(parentSessionId, "worker", "inspect exactly this"),
        agent_type: "scout",
      });
      const info = manager.getAgentInfo("worker", parentSessionId);
      expect(info).toMatchObject({
        profile: "scout",
        color: "accent",
        isReadonly: true,
        provider: "openai",
        modelId: "gpt-5.6-luna",
      });
      await waitUntil(() => manager.getAgentInfo("worker", parentSessionId).status === "completed");
      const records = fs
        .readFileSync(info.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.find((record) => record.type === "prompt")?.message).toBe(
        "inspect exactly this",
      );
      const start = records.find((record) => record.type === "started");
      expect(start.env).toMatchObject({
        PI_SUBAGENT_PROFILE: "scout",
        PI_SUBAGENT_READONLY: "1",
      });
      expect(start.args[start.args.indexOf("--append-system-prompt") + 1]).toContain(
        "This subagent role is read-only.",
      );
      expect(start.args[start.args.indexOf("--tools") + 1]).toContain("fff-multi-grep");
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  processTest(
    "reclaims a fresh lock whose PID identity no longer owns it, even with retention disabled",
    async () => {
      const parentSessionId = "fresh-dead-lock";
      const packageDir = path.join(TEST_AGENT_DIR, "pi-codex-subagents");
      const configFile = path.join(packageDir, "config.json");
      const scope = path.join(packageDir, "runs", parentScopeKey(parentSessionId));
      const lockFile = path.join(scope, `.task-${taskStorageKey("worker")}.lock`);
      fs.mkdirSync(scope, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify({ retentionDays: 0 }));
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          pid: process.pid,
          processIdentity: "identity-from-an-exited-process",
          createdAt: Date.now(),
        }),
      );
      const manager = createAgentManager();
      try {
        await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold lock recovery"));
        expect(manager.getAgentInfo("worker", parentSessionId).status).toBe("running");
        expect(fs.existsSync(lockFile)).toBe(false);
        await manager.interruptAgent(parentSessionId, "worker");
      } finally {
        await manager.shutdown();
        fs.rmSync(scope, { recursive: true, force: true });
        fs.rmSync(configFile, { force: true });
      }
    },
  );

  processTest("does not unlink a live lock that replaces the inspected dead instance", async () => {
    const parentSessionId = "lock-replacement-race";
    const packageDir = path.join(TEST_AGENT_DIR, "pi-codex-subagents");
    const configFile = path.join(packageDir, "config.json");
    const scope = path.join(packageDir, "runs", parentScopeKey(parentSessionId));
    const lockFile = path.join(scope, `.task-${taskStorageKey("worker")}.lock`);
    const displacedLock = `${lockFile}.displaced`;
    fs.mkdirSync(scope, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ retentionDays: 0 }));
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        processIdentity: "identity-from-an-exited-process",
        token: "dead-instance",
        createdAt: Date.now(),
      }),
    );
    let replaced = false;
    const manager = createAgentManager({
      beforeReclaimTaskLockRemoval(file: string) {
        if (replaced) return;
        replaced = true;
        fs.renameSync(file, displacedLock);
        fs.writeFileSync(
          file,
          JSON.stringify({
            pid: process.pid,
            token: "live-replacement",
            createdAt: Date.now(),
          }),
        );
      },
    });
    try {
      await expect(
        manager.spawnAgent(spawnParams(parentSessionId, "worker", "must not start")),
      ).rejects.toThrow("already being created");
      expect(replaced).toBe(true);
      expect(JSON.parse(fs.readFileSync(lockFile, "utf8"))).toMatchObject({
        pid: process.pid,
        token: "live-replacement",
      });
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      fs.rmSync(configFile, { force: true });
    }
  });

  processTest("reconciles a persisted starting record left before child ownership", async () => {
    const parentSessionId = "starting-without-owner";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const id = "33333333-3333-4333-8333-333333333333";
    const infoFile = path.join(scope, `${id}.info.json`);
    const now = Date.now();
    fs.rmSync(scope, { recursive: true, force: true });
    fs.mkdirSync(scope, { recursive: true });
    fs.writeFileSync(
      infoFile,
      JSON.stringify({
        id,
        taskName: "worker",
        canonicalName: "/worker",
        parentSessionId,
        provider: "test",
        modelId: "fake",
        model: "test:fake",
        cwd: TEST_AGENT_DIR,
        sessionFile: path.join(scope, `${id}.jsonl`),
        infoFile,
        logFile: path.join(scope, `${id}.log`),
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        lastActivity: now,
        messageCount: 0,
        status: "starting",
      }),
    );
    const manager = createAgentManager();
    try {
      await manager.ready();
      const reconciled = manager.getAgentInfo("worker", parentSessionId);
      expect(reconciled.status).toBe("interrupted");
      expect(reconciled.childProcess).toBeUndefined();
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  processTest(
    "persists provisional ownership before the startup RPC round trip completes",
    async () => {
      const parentSessionId = "startup-crash-window";
      const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
      fs.rmSync(scope, { recursive: true, force: true });
      const manager = createAgentManager({
        childEnv: { PI_SUBAGENT_TEST_GET_STATE_DELAY_MS: "300" },
      });
      let spawnSettled = false;
      try {
        const spawning = manager
          .spawnAgent(spawnParams(parentSessionId, "worker", "hold startup"))
          .finally(() => {
            spawnSettled = true;
          });
        await waitUntil(() => {
          try {
            return Boolean(manager.getAgentInfo("worker", parentSessionId).childProcess);
          } catch {
            return false;
          }
        });
        const starting = manager.getAgentInfo("worker", parentSessionId);
        expect(starting.status).toBe("starting");
        expect(starting.childProcess?.pid).toBeNumber();
        expect(pidAlive(starting.childProcess!.pid)).toBe(true);
        expect(spawnSettled).toBe(false);
        await spawning;
        await manager.interruptAgent(parentSessionId, "worker");
      } finally {
        await manager.shutdown();
        fs.rmSync(scope, { recursive: true, force: true });
      }
    },
  );

  processTest("hibernates after settle and lazily restarts the persisted session", async () => {
    fs.rmSync(path.join(TEST_AGENT_DIR, "pi-codex-subagents", "config.json"), { force: true });
    const parentSessionId = "lifecycle-settle";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
      recursive: true,
      force: true,
    });
    const manager = createAgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"));
      const first = manager.getAgentInfo("worker", parentSessionId);
      const firstPid = first.childProcess!.pid;
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "completed" && !info.childProcess;
      });
      expect(pidAlive(firstPid)).toBe(false);
      expect(manager.readAgentResponse("worker", parentSessionId).finalResponse).toBe(
        "response:first",
      );

      expect(await manager.sendMessage(parentSessionId, "worker", "second")).toEqual({
        delivery: "prompt",
      });
      const secondPid = manager.getAgentInfo("worker", parentSessionId).childProcess!.pid;
      expect(secondPid).not.toBe(firstPid);
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "completed" && !info.childProcess;
      });
      expect(pidAlive(secondPid)).toBe(false);
      expect(manager.readAgentResponse("worker", parentSessionId).finalResponse).toBe(
        "response:second",
      );
      const sessionRecords = fs
        .readFileSync(first.sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const starts = sessionRecords.filter((entry) => entry.type === "started");
      expect(new Set(starts.map((entry) => entry.pid)).size).toBe(2);
      for (const start of starts) {
        expect(start.args).toContain("--no-context-files");
        expect(start.args).toContain("--no-skills");
        expect(start.args).toContain("--no-prompt-templates");
        expect(start.args).not.toContain("--no-extensions");
        expect(start.args).not.toContain("--extension");
        expect(start.args).not.toContain("--system-prompt");
        expect(start.args[start.args.indexOf("--append-system-prompt") + 1]).toContain(
          "You are an implementation subagent.",
        );
        expect(
          start.args.slice(
            start.args.indexOf("--provider"),
            start.args.indexOf("--provider") + 4,
          ),
        ).toEqual(["--provider", "anthropic", "--model", "claude-sonnet-5"]);
        expect(start.args[start.args.indexOf("--thinking") + 1]).toBe("high");
        expect(start.args[start.args.indexOf("--tools") + 1]).toBe(
          "read,bash,edit,write,grep,find,ls,hashline_read,hashline_write,safe_rm",
        );
        expect(start.env).toMatchObject({
          PI_SUBAGENT_PROFILE: "implementer",
          PI_SUBAGENT_READONLY: "0",
        });
        expect(start.env.PI_SUBAGENT_OWNER_TOKEN).toBeString();
        expect(start.env).not.toHaveProperty("PI_SESSION_ID");
        expect(start.env).not.toHaveProperty("PI_SESSION_FILE");
        expect(start.env).not.toHaveProperty("PI_PROVIDER");
        expect(start.env).not.toHaveProperty("PI_MODEL");
        expect(start.env).not.toHaveProperty("PI_REASONING_LEVEL");
      }
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
        recursive: true,
        force: true,
      });
    }
  });

  processTest("hibernates after failure while preserving the error", async () => {
    const parentSessionId = "lifecycle-failure";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
      recursive: true,
      force: true,
    });
    const manager = createAgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "fail now"));
      const started = manager.getAgentInfo("worker", parentSessionId);
      const pid = started.childProcess!.pid;
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "failed" && !info.childProcess;
      });
      const failed = manager.readAgentResponse("worker", parentSessionId);
      expect(failed.error).toBe("fake failure");
      expect(pidAlive(pid)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
        recursive: true,
        force: true,
      });
    }
  });


  processTest("accepts Darwin process ownership when ps cannot expose the token", async () => {
    if (process.platform !== "darwin") return;
    const parentSessionId = "lifecycle-darwin";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
      recursive: true,
      force: true,
    });
    const manager = createAgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold darwin"));
      const running = manager.getAgentInfo("worker", parentSessionId);
      expect(running.childProcess?.pid).toBeNumber();
      expect(pidAlive(running.childProcess!.pid)).toBe(true);
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
        recursive: true,
        force: true,
      });
    }
  });

  processTest("interrupt terminates the child and clears runtime artifacts", async () => {
    const parentSessionId = "lifecycle-interrupt";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
      recursive: true,
      force: true,
    });
    const manager = createAgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold interrupt"));
      const running = manager.getAgentInfo("worker", parentSessionId);
      const pid = running.childProcess!.pid;
      expect((await manager.interruptAgent(parentSessionId, "worker")).previous_status).toBe(
        "running",
      );
      const interrupted = manager.getAgentInfo("worker", parentSessionId);
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.childProcess).toBeUndefined();
      expect(pidAlive(pid)).toBe(false);
      const socketDir = path.join(
        process.env.PI_SUBAGENT_TEMP_DIR!,
        "pi-codex-subagents",
        os.userInfo().username,
        "sockets",
      );
      expect(fs.existsSync(path.join(socketDir, `${running.id}.active.json`))).toBe(false);
      expect(fs.existsSync(path.join(socketDir, `${running.id}.peek.json`))).toBe(false);
      if (process.platform !== "win32")
        expect(fs.existsSync(getSocketPath(running.id))).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
        recursive: true,
        force: true,
      });
    }
  });

  processTest("reconciles owned children without risking PID-reuse kills", async () => {
    const parentSessionId = "lifecycle-reconcile";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
      recursive: true,
      force: true,
    });
    const owner = createAgentManager();
    const reconcilers: Array<InstanceType<typeof AgentManager>> = [];
    try {
      await owner.spawnAgent(spawnParams(parentSessionId, "orphan", "hold orphan"));
      const orphanPid = owner.getAgentInfo("orphan", parentSessionId).childProcess!.pid;
      const reconciler = createAgentManager();
      reconcilers.push(reconciler);
      await waitUntil(() => {
        const info = reconciler.getAgentInfo("orphan", parentSessionId);
        return info.status === "interrupted" && !info.childProcess;
      });
      await waitUntil(() => !pidAlive(orphanPid));
      expect(pidAlive(orphanPid)).toBe(false);

      await owner.spawnAgent(spawnParams(parentSessionId, "pid-reuse", "hold identity"));
      const mismatched = owner.getAgentInfo("pid-reuse", parentSessionId);
      const mismatchedPid = mismatched.childProcess!.pid;
      mismatched.childProcess!.processIdentity = "not-the-owned-process";
      fs.writeFileSync(mismatched.infoFile, JSON.stringify(mismatched, null, 2));
      const mismatchReconciler = createAgentManager();
      reconcilers.push(mismatchReconciler);
      await waitUntil(() => {
        const info = mismatchReconciler.getAgentInfo("pid-reuse", parentSessionId);
        return info.status === "interrupted" && !info.childProcess;
      });
      expect(pidAlive(mismatchedPid)).toBe(true);
      await owner.shutdown();
      expect(pidAlive(mismatchedPid)).toBe(false);
    } finally {
      await Promise.all([owner.shutdown(), ...reconcilers.map((manager) => manager.shutdown())]);
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("completion delivery", () => {
  processTest("publishes unclaimed settled and abnormal-exit completions", async () => {
    const parentSessionId = "completion-callbacks";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = createAgentManager({
      onUnclaimedCompletion: (event: any) => completions.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "settled", "first"));
      await waitUntil(() => completions.some((event) => event.agentName === "/settled"));
      expect(completions.filter((event) => event.agentName === "/settled")).toHaveLength(1);
      expect(completions.find((event) => event.agentName === "/settled")).toMatchObject({
        status: "completed",
        finalResponse: "response:first",
      });

      await manager.spawnAgent(spawnParams(parentSessionId, "crashed", "crash now"));
      await waitUntil(() => completions.some((event) => event.agentName === "/crashed"));
      expect(completions.filter((event) => event.agentName === "/crashed")).toHaveLength(1);
      expect(completions.find((event) => event.agentName === "/crashed")).toMatchObject({
        status: "failed",
      });
      expect(completions.find((event) => event.agentName === "/crashed").error).toContain(
        "code=23",
      );
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  processTest("suppresses automatic delivery while wait tools claim completions", async () => {
    const parentSessionId = "completion-waits";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = createAgentManager({
      onUnclaimedCompletion: (event: any) => completions.push(event),
    });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "one", "first"));
      const waited = await manager.waitAgent(parentSessionId, ["one"]);
      expect(waited.event).toMatchObject({ agentName: "/one", status: "completed" });
      expect(completions).toEqual([]);

      await manager.spawnAgent(spawnParams(parentSessionId, "two", "second"));
      const all = await manager.waitAllAgents(parentSessionId, ["two"]);
      expect(all.responses).toEqual([
        expect.objectContaining({ agent_name: "/two", status: "completed" }),
      ]);
      expect(completions).toEqual([]);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  processTest("releases suppressed completions when wait_all_agents is cancelled", async () => {
    const parentSessionId = "completion-wait-cancel";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = createAgentManager({
      onUnclaimedCompletion: (event: any) => completions.push(event),
    });
    const controller = new AbortController();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "slow", "hold slow"));
      await manager.spawnAgent(spawnParams(parentSessionId, "fast", "fast"));
      const wait = manager.waitAllAgents(parentSessionId, ["slow", "fast"], controller.signal);
      await waitUntil(() => manager.getAgentInfo("fast", parentSessionId).status === "completed");
      expect(completions).toEqual([]);
      controller.abort(new Error("cancelled"));
      await expect(wait).rejects.toThrow("aborted");
      await waitUntil(() => completions.some((event) => event.agentName === "/fast"));
      expect(completions.filter((event) => event.agentName === "/fast")).toHaveLength(1);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  processTest("reports active and inactive lifecycle transitions", async () => {
    const parentSessionId = "status-transitions";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const activity: boolean[] = [];
    const manager = createAgentManager({
      onActivityChange: (event: any) => {
        if (event.parentSessionId === parentSessionId) activity.push(event.active);
      },
    });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"));
      await waitUntil(() => manager.getAgentInfo("worker", parentSessionId).status === "completed");
      expect(activity).toContain(true);
      expect(activity.at(-1)).toBe(false);

      const settled = manager.getAgentInfo("worker", parentSessionId);
      const rejectedAt = activity.length;
      await expect(
        manager.sendMessage(parentSessionId, "worker", "reject restart"),
      ).rejects.toThrow("fake prompt rejection");
      expect(manager.getAgentInfo("worker", parentSessionId)).toMatchObject({
        status: "completed",
        finalResponse: settled.finalResponse,
        completedAt: settled.completedAt,
      });
      expect(manager.getAgentInfo("worker", parentSessionId).childProcess).toBeUndefined();
      expect(activity.slice(rejectedAt)).toContain(true);
      expect(activity.at(-1)).toBe(false);

      const restartAt = activity.length;
      await manager.sendMessage(parentSessionId, "worker", "hold restart");
      expect(activity.slice(restartAt)).toContain(true);
      await manager.interruptAgent(parentSessionId, "worker");
      expect(activity.at(-1)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });
});

describe("extension completion delivery and TUI", () => {
  processTest(
    "registers commands, renders one-line activity, and delivers bounded completions",
    async () => {
      const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
      const tools = new Map<string, any>();
      const commands = new Map<string, any>();
      const renderers = new Map<string, any>();
      const sentMessages: Array<{ message: any; options: any }> = [];
      let widget: any;
      const pi: any = {
        on(name: string, handler: (event: any, ctx: any) => any) {
          const entries = handlers.get(name) ?? [];
          entries.push(handler);
          handlers.set(name, entries);
        },
        registerTool(tool: any) {
          tools.set(tool.name, tool);
        },
        registerCommand(name: string, command: any) {
          commands.set(name, command);
        },
        registerMessageRenderer(name: string, renderer: any) {
          renderers.set(name, renderer);
        },
        sendMessage(message: any, options: any) {
          sentMessages.push({ message, options });
        },
        getThinkingLevel() {
          return "high";
        },
        getActiveTools() {
          return ["read", "bash"];
        },
      };
      const parentSessionId = "index-integration-parent";
      const ctx: any = {
        cwd: TEST_AGENT_DIR,
        mode: "tui",
        model: { provider: "test", id: "fake" },
        modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
        sessionManager: {
          getSessionId: () => parentSessionId,
          getSessionFile: () => path.join(TEST_AGENT_DIR, "parent.jsonl"),
        },
        ui: {
          setWidget(_key: string, value: any) {
            widget = value;
          },
        },
      };
      const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
      fs.rmSync(scope, { recursive: true, force: true });
      const { default: subagentExtension } = await import("../index.js");
      subagentExtension(pi, { piCommand: { command: FAKE_RPC_CHILD } });
      const emit = async (name: string, event: any = {}) => {
        for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
      };

      try {
        await emit("session_start", { reason: "startup" });
        expect(commands.has("agents")).toBe(true);
        expect(commands.has("subagent")).toBe(true);
        expect(commands.has("subagents")).toBe(true);
        expect(renderers.has("pi-codex-subagent-completion")).toBe(true);
        expect(tools.get("spawn_agent").parameters.required).toContain("agent_type");
        expect(tools.get("spawn_agent").parameters.properties.skills).toBeUndefined();
        expect(tools.get("spawn_agent").parameters.properties.agent_type.enum).toEqual([
          "scout",
          "librarian",
          "implementer",
          "reviewer",
        ]);

        await tools.get("spawn_agent").execute(
          "spawn-1",
          {
            task_name: "x".repeat(200),
            message: "slow finish",
            agent_type: "implementer",
          },
          undefined,
          undefined,
          ctx,
        );

        expect(widget).toBeFunction();
        const colorCalls: string[] = [];
        const theme = {
          fg: (color: string, text: string) => {
            colorCalls.push(color);
            return text;
          },
          bold: (text: string) => text,
        };
        const lines = widget({}, theme).render(40);
        expect(lines).toHaveLength(1);
        expect(visibleWidth(lines[0])).toBeLessThanOrEqual(40);
        expect(lines[0]).toContain("/subagents");
        expect(colorCalls).toContain("success");
        colorCalls.length = 0;
        tools.get("spawn_agent").renderCall(
          { task_name: "research", agent_type: "librarian" },
          theme,
        );
        expect(colorCalls).toContain("mdLink");
        colorCalls.length = 0;
        renderers.get("pi-codex-subagent-completion")(
          {
            details: {
              agent_name: "/research",
              status: "completed",
              profile: "librarian",
              color: "mdLink",
            },
          },
          { expanded: false },
          theme,
        );
        expect(colorCalls).toContain("mdLink");
        expect(colorCalls).toContain("success");

        await waitUntil(() => sentMessages.length === 1);
        expect(widget).toBeUndefined();
        expect(sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
        expect(sentMessages[0].message.content).toContain("response:slow finish");

        await tools.get("spawn_agent").execute(
          "spawn-2",
          {
            task_name: "large-output",
            message: "large response",
            agent_type: "implementer",
          },
          undefined,
          undefined,
          ctx,
        );
        await waitUntil(() => sentMessages.length === 2);
        const large = sentMessages[1].message;
        expect(Buffer.byteLength(large.content, "utf8")).toBeLessThanOrEqual(50 * 1024);
        expect(large.content).toContain("Output truncated");
        expect(large.details.fullOutputPath).toBeString();
        expect(fs.existsSync(large.details.fullOutputPath)).toBe(true);

        await tools.get("spawn_agent").execute(
          "spawn-3",
          { task_name: "hold-scout", message: "hold scout", agent_type: "scout" },
          undefined,
          undefined,
          ctx,
        );
        await tools.get("spawn_agent").execute(
          "spawn-4",
          { task_name: "hold-library", message: "hold library", agent_type: "librarian" },
          undefined,
          undefined,
          ctx,
        );
        colorCalls.length = 0;
        const multiple = widget({}, theme).render(32);
        expect(multiple.every((line: string) => visibleWidth(line) <= 32)).toBe(true);
        expect(colorCalls).toContain("accent");
        expect(colorCalls).toContain("mdLink");
      } finally {
        await emit("session_shutdown", { reason: "quit" });
        fs.rmSync(scope, { recursive: true, force: true });
      }
    },
  );
});

describe("subagent peek overlay", () => {
  function createOverlay(columns = 80, rows = 20) {
    const now = Date.now();
    const info = {
      id: "44444444-4444-4444-8444-444444444444",
      taskName: "a-very-long-agent-name",
      canonicalName: "/a-very-long-agent-name",
      parentSessionId: "peek-parent",
      profile: "reviewer",
      color: "warning" as const,
      isReadonly: true,
      provider: "test",
      modelId: "a-very-long-model-name",
      model: "test:a-very-long-model-name",
      cwd: TEST_AGENT_DIR,
      sessionFile: path.join(TEST_AGENT_DIR, "nonexistent-peek-session.jsonl"),
      infoFile: path.join(TEST_AGENT_DIR, "nonexistent-peek.info.json"),
      logFile: path.join(TEST_AGENT_DIR, "nonexistent-peek.log"),
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      status: "completed" as const,
    };
    const tui = {
      terminal: { columns, rows },
      requestRender() {},
    } as any;
    const theme = {
      fg: (_color: string, text: string) => text,
    } as any;
    return new SubagentPeekOverlay(tui, theme, info, () => {});
  }

  test("initially follows a long transcript at the end", () => {
    const overlay = createOverlay();
    try {
      const internals = overlay as any;
      internals.cachedLines = Array.from({ length: 30 }, (_, index) => `line-${index}`);
      internals.cachedWidth = 38;

      const rendered = overlay.render(40);
      expect(internals.scrollOffset).toBe(18);
      expect(rendered[1]).toContain("line-18");
      expect(rendered[12]).toContain("line-29");
    } finally {
      overlay.dispose();
    }
  });

  test("renders profile identity separately from semantic status color", () => {
    const overlay = createOverlay();
    try {
      const colors: string[] = [];
      (overlay as any).theme = {
        fg(color: string, text: string) {
          colors.push(color);
          return text;
        },
      };
      overlay.render(40);
      expect(colors).toContain("warning");
      expect(colors).toContain("success");
    } finally {
      overlay.dispose();
    }
  });

  test("keeps every frame line within a narrow render width", () => {
    const overlay = createOverlay(12, 14);
    try {
      const internals = overlay as any;
      internals.cachedLines = ["content that is much wider than the overlay"];
      internals.cachedWidth = 10;

      const rendered = overlay.render(12);
      expect(rendered.length).toBeGreaterThan(0);
      expect(rendered.every((line: string) => visibleWidth(line) <= 12)).toBe(true);
    } finally {
      overlay.dispose();
    }
  });
});

describe("completion mailbox", () => {
  test("waits until explicitly cancelled when no completion exists", async () => {
    const manager = createAgentManager();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 10);
    await expect(manager.waitAgent("empty-parent", undefined, controller.signal)).rejects.toThrow(
      "cancelled",
    );
    await manager.shutdown();
  });

  test("consumes one matching completion without dropping siblings", () => {
    const events = [
      { id: "1", parentSessionId: "parent", agentName: "/one", status: "completed", createdAt: 1 },
      { id: "2", parentSessionId: "parent", agentName: "/two", status: "completed", createdAt: 2 },
      { id: "3", parentSessionId: "other", agentName: "/one", status: "completed", createdAt: 3 },
    ] as any[];
    expect(consumeFirstMatchingMailboxEvent(events, "parent")?.agentName).toBe("/one");
    expect(events.map((event) => event.id)).toEqual(["2", "3"]);
    expect(consumeFirstMatchingMailboxEvent(events, "parent", new Set(["/two"]))?.agentName).toBe(
      "/two",
    );
    expect(events.map((event) => event.id)).toEqual(["3"]);
  });
});
