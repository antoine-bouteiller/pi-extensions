import { describe, expect, test } from "bun:test";
import { buildAskUserResultMessage } from "../prompt";

describe("ask_user result messages", () => {
  test("describes selected and custom answers", () => {
    expect(buildAskUserResultMessage({ kind: "selected", answer: "Ship it", index: 2 })).toBe(
      "User selected option 2: Ship it",
    );
    expect(buildAskUserResultMessage({ kind: "custom", answer: "Wait until Friday" })).toBe(
      "User wrote their own answer: Wait until Friday",
    );
  });

  test("does not invent an answer when dismissed", () => {
    expect(buildAskUserResultMessage({ kind: "dismissed" })).toContain("Do not assume an answer");
    expect(buildAskUserResultMessage({ kind: "no-ui" })).toContain("plain text");
  });
});
