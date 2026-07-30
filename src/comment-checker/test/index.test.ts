import { describe, expect, test } from "bun:test";
import commentChecker, { type CheckerRunner } from "../index.js";
import { createFakePi } from "#test-utils/fake-pi";

const context = {
  cwd: "/workspace",
  sessionManager: { getSessionId: () => "session-1" },
};

describe("comment checker", () => {
  test("appends checker warnings after writes", async () => {
    const inputs: Array<Parameters<CheckerRunner>[0]> = [];
    const fixture = createFakePi();
    commentChecker(fixture.pi, async (input) => {
      inputs.push(input);
      return { exitCode: 2, stdout: "", stderr: "remove this comment" };
    });

    const [result] = await fixture.emit(
      "tool_result",
      {
        toolName: "write",
        input: { path: "src/main.ts", content: "// redundant\nconst value = 1;\n" },
        content: [{ type: "text", text: "Wrote src/main.ts" }],
        isError: false,
      },
      context,
    );

    expect(inputs).toEqual([
      {
        session_id: "session-1",
        tool_name: "Write",
        transcript_path: "",
        cwd: "/workspace",
        hook_event_name: "PostToolUse",
        tool_input: {
          file_path: "src/main.ts",
          content: "// redundant\nconst value = 1;\n",
        },
      },
    ]);
    expect(result).toEqual({
      content: [
        { type: "text", text: "Wrote src/main.ts" },
        { type: "text", text: "\n\nremove this comment" },
      ],
    });
  });

  test("converts Pi edit batches to MultiEdit input", async () => {
    const inputs: Array<Parameters<CheckerRunner>[0]> = [];
    const fixture = createFakePi();
    commentChecker(fixture.pi, async (input) => {
      inputs.push(input);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const [result] = await fixture.emit(
      "tool_result",
      {
        toolName: "edit",
        input: {
          path: "src/main.ts",
          edits: [
            { oldText: "const one = 1;", newText: "const first = 1;" },
            { oldText: "const two = 2;", newText: "const second = 2;" },
          ],
        },
        content: [{ type: "text", text: "Edited src/main.ts" }],
        isError: false,
      },
      context,
    );

    expect(inputs[0]?.tool_input).toEqual({
      file_path: "src/main.ts",
      edits: [
        { old_string: "const one = 1;", new_string: "const first = 1;" },
        { old_string: "const two = 2;", new_string: "const second = 2;" },
      ],
    });
    expect(result).toBeUndefined();
  });

  test("ignores failed and unrelated tool results", async () => {
    let calls = 0;
    const fixture = createFakePi();
    commentChecker(fixture.pi, async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await fixture.emit(
      "tool_result",
      {
        toolName: "write",
        input: { path: "src/main.ts", content: "const value = 1;" },
        content: [],
        isError: true,
      },
      context,
    );
    await fixture.emit(
      "tool_result",
      { toolName: "read", input: { path: "src/main.ts" }, content: [], isError: false },
      context,
    );

    expect(calls).toBe(0);
  });
});
