import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "../profiles.js";
import {
  AGENT_CONFIGS,
  AGENT_PROFILE_NAMES,
  configuredProfileColor,
  firstAvailable,
  getAgentProfileNames,
  getAgentProfilesDescription,
  hasModelId,
  parseModelSelector,
  resolveAgentConfig,
  resolveModelSelector,
} from "../profiles.js";

const availableModels = [
  { provider: "azure-openai-responses", id: "gpt-5.6-luna" },
  { provider: "openai", id: "gpt-5.6-luna" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "anthropic", id: "claude-opus-5" },
  { provider: "openai", id: "gpt-5.6-sol" },
] as const;

const context = {
  availableModels,
  parentModel: { provider: "openai", id: "gpt-5.6-sol" },
};

describe("model selectors", () => {
  test("parses bare and provider-qualified exact selectors", () => {
    expect(parseModelSelector("claude-sonnet-5")).toEqual({ id: "claude-sonnet-5" });
    expect(parseModelSelector("anthropic/claude-sonnet-5")).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-5",
    });
    expect(() => parseModelSelector("anthropic/")).toThrow("Invalid provider-qualified");
  });

  test("prefers the canonical provider, then official variants, deterministically", () => {
    expect(resolveModelSelector("gpt-5.6-luna", availableModels)).toEqual({
      provider: "openai",
      id: "gpt-5.6-luna",
    });
    expect(
      resolveModelSelector("gpt-5.6-luna", [
        { provider: "custom-z", id: "gpt-5.6-luna" },
        { provider: "azure-openai-responses", id: "gpt-5.6-luna" },
      ]),
    ).toEqual({ provider: "azure-openai-responses", id: "gpt-5.6-luna" });
    expect(
      resolveModelSelector("anthropic/claude-sonnet-5", availableModels),
    ).toEqual({ provider: "anthropic", id: "claude-sonnet-5" });
  });

  test("uses only exact authenticated non-Google models", () => {
    expect(() => resolveModelSelector("gpt-5.6", availableModels)).toThrow("not authenticated");
    expect(() =>
      resolveModelSelector("gemini-2.5-pro", [
        { provider: "google", id: "gemini-2.5-pro" },
      ]),
    ).toThrow("not authenticated");
    expect(hasModelId(availableModels, "claude-opus-5")).toBe(true);
    expect(firstAvailable(availableModels, "missing", "claude-opus-5")).toBe("claude-opus-5");
  });
});

describe("generic agent registry", () => {
  test("contains the four built-ins and generates descriptions from registry keys", () => {
    expect(AGENT_PROFILE_NAMES).toEqual(["scout", "librarian", "implementer", "reviewer"]);
    const description = getAgentProfilesDescription();
    for (const key of AGENT_PROFILE_NAMES) expect(description).toContain(`\`${key}\``);
    expect(configuredProfileColor("librarian")).toBe("mdLink");
    expect(configuredProfileColor("missing")).toBe("muted");
  });

  test("normalizes defaults for a future entry with only the four required fields", () => {
    const registry = {
      future: {
        allowedTools: ["read", "read"],
        model: "anthropic/claude-haiku-4-5",
        prompt: "Do future work.",
        isReadonly: true,
      },
    } satisfies Record<string, AgentConfig>;
    expect(getAgentProfileNames(registry)).toEqual(["future"]);
    expect(getAgentProfilesDescription(registry)).toContain("`future` — future");
    expect(resolveAgentConfig("future", context, registry)).toMatchObject({
      key: "future",
      allowedTools: ["read"],
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      description: "future",
      thinking: "high",
      color: "accent",
      isReadonly: true,
    });
  });

  test("passes immutable context to function selectors", () => {
    let received: any;
    const registry = {
      selected: {
        allowedTools: ["read"],
        model: (selectorContext) => {
          received = selectorContext;
          return selectorContext.parentModel.provider === "openai"
            ? "claude-opus-5"
            : "gpt-5.6-sol";
        },
        prompt: "Review.",
        isReadonly: true,
      },
    } satisfies Record<string, AgentConfig>;
    expect(resolveAgentConfig("selected", context, registry).modelId).toBe("claude-opus-5");
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received.availableModels)).toBe(true);
    expect(Object.isFrozen(received.availableModels[0])).toBe(true);
    expect(Object.isFrozen(received.parentModel)).toBe(true);
  });

  test("resolves every built-in solely from its config", () => {
    const expected = {
      scout: {
        modelId: "gpt-5.6-luna",
        thinking: "low",
        color: "accent",
        isReadonly: true,
      },
      librarian: {
        modelId: "claude-haiku-4-5",
        thinking: "low",
        color: "mdLink",
        isReadonly: true,
      },
      implementer: {
        modelId: "claude-sonnet-5",
        thinking: "high",
        color: "success",
        isReadonly: false,
      },
      reviewer: {
        modelId: "claude-opus-5",
        thinking: "high",
        color: "warning",
        isReadonly: true,
      },
    } as const;
    for (const key of AGENT_PROFILE_NAMES) {
      const resolved = resolveAgentConfig(key, context);
      expect(resolved).toMatchObject(expected[key]);
      expect(resolved.allowedTools).toEqual(AGENT_CONFIGS[key].allowedTools);
      expect(resolved.prompt.length).toBeGreaterThan(20);
    }
    expect(
      resolveAgentConfig("reviewer", {
        ...context,
        parentModel: { provider: "anthropic", id: "claude-opus-5" },
      }).modelId,
    ).toBe("gpt-5.6-sol");
  });

  test("fails unknown, unavailable, and invalid selector results", () => {
    expect(() => resolveAgentConfig("missing", context)).toThrow("Unknown agent profile");
    expect(() =>
      resolveAgentConfig("implementer", {
        ...context,
        availableModels: availableModels.filter((model) => model.id !== "claude-sonnet-5"),
      }),
    ).toThrow("not authenticated");
    const registry = {
      bad: {
        allowedTools: ["read"],
        model: () => "",
        prompt: "Bad.",
        isReadonly: false,
      },
    } satisfies Record<string, AgentConfig>;
    expect(() => resolveAgentConfig("bad", context, registry)).toThrow("must not be empty");
  });
});
