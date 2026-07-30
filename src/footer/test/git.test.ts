import { describe, expect, test } from "bun:test";
import { createFakePi } from "#test-utils/fake-pi";
import { fetchGitInfo } from "../git";

const success = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });

describe("footer git state", () => {
  test("reports the current branch and porcelain entry count", async () => {
    const calls: string[][] = [];
    const outputs = [success("true\n"), success("feature/footer\n"), success(" M one\n?? two\n")];
    const { pi } = createFakePi({
      exec: async (command, args) => {
        calls.push([command, ...args]);
        return outputs.shift()!;
      },
    });

    expect(await fetchGitInfo(pi)).toEqual({
      branch: "feature/footer",
      changedFiles: 2,
      pullRequest: null,
    });
    expect(calls).toEqual([
      ["git", "rev-parse", "--is-inside-work-tree"],
      ["git", "branch", "--show-current"],
      ["git", "status", "--short"],
    ]);
  });

  test("returns empty state outside a repository or when git fails", async () => {
    const outside = createFakePi({
      exec: async (_command, args) =>
        args[0] === "rev-parse" ? { ...success("false\n"), code: 128 } : success("ignored"),
    });
    const failing = createFakePi({
      exec: async () => {
        throw new Error("git unavailable");
      },
    });

    const empty = { branch: null, changedFiles: 0, pullRequest: null };
    expect(await fetchGitInfo(outside.pi)).toEqual(empty);
    expect(await fetchGitInfo(failing.pi)).toEqual(empty);
  });

  test("does not use failed branch or status command output", async () => {
    const outputs = [
      success("true\n"),
      { ...success("stale-branch\n"), code: 1 },
      { ...success(" M stale\n"), code: 1 },
    ];
    const { pi } = createFakePi({
      exec: async () => outputs.shift()!,
    });

    expect(await fetchGitInfo(pi)).toEqual({
      branch: null,
      changedFiles: 0,
      pullRequest: null,
    });
  });
});
