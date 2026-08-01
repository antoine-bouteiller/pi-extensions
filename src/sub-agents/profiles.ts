import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AvailableModel {
  provider: string;
  id: string;
}

export interface ModelSelectorContext {
  availableModels: readonly Readonly<AvailableModel>[];
  parentModel: Readonly<AvailableModel>;
}

export type ModelSelector = string | ((context: ModelSelectorContext) => string);

export interface AgentConfig {
  allowedTools: readonly string[];
  model: ModelSelector;
  prompt: string;
  isReadonly: boolean;
  description?: string;
  thinking?: ThinkingLevel;
  color?: ThemeColor;
}

export interface ResolvedAgentConfig {
  key: string;
  allowedTools: readonly string[];
  provider: string;
  modelId: string;
  prompt: string;
  isReadonly: boolean;
  description: string;
  thinking: ThinkingLevel;
  color: ThemeColor;
}

const EXPLORATION_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "mcp",
  "fffind",
  "ffgrep",
  "fff-multi-grep",
] as const;

export const AGENT_CONFIGS = {
  scout: {
    allowedTools: EXPLORATION_TOOLS,
    model: "gpt-5.6-luna",
    prompt: `You are a fast codebase scout. Explore the assigned repository scope efficiently and return a concise, factual report for the parent agent. Identify the relevant files, symbols, behavior, tests, and risks. Quote exact paths and line references where useful. Do not modify files.`,
    isReadonly: true,
    description: "Quick codebase exploration and focused implementation reconnaissance",
    thinking: "low",
    color: "accent",
  },
  librarian: {
    allowedTools: ["webfetch", "mcp"],
    model: "claude-haiku-4-5",
    prompt: `You are a research librarian. Investigate the assigned external, web, or remote-system question and return a concise synthesis. Cite source URLs or remote record identifiers for every important claim, distinguish facts from inference, and call out uncertainty. Do not modify remote or local state.`,
    isReadonly: true,
    description: "Cited web and remote-system research",
    thinking: "low",
    color: "mdLink",
  },
  implementer: {
    allowedTools: [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "hashline_read",
      "hashline_write",
      "safe_rm",
    ],
    model: "claude-sonnet-5",
    prompt: `You are an implementation subagent. Make the requested code changes within the assigned scope, preserve existing conventions, and verify the result with focused tests and typechecking. Report changed files, verification performed, and any remaining risks. Do not expand the task beyond the request.`,
    isReadonly: false,
    description: "Scoped code implementation and verification",
    thinking: "high",
    color: "success",
  },
  reviewer: {
    allowedTools: EXPLORATION_TOOLS,
    model: ({ parentModel }) =>
      parentModel.provider === "anthropic" ? "gpt-5.6-sol" : "claude-opus-5",
    prompt: `You are a read-only senior reviewer. Review the requested plan or implementation for correctness, security, performance, architecture, maintainability, and test coverage. Inspect evidence directly, prioritize actionable findings by severity, and include exact file and line references. Do not modify files or remote state.`,
    isReadonly: true,
    description: "Read-only plan and implementation review",
    thinking: "high",
    color: "warning",
  },
} satisfies Record<string, AgentConfig>;

export type AgentProfileName = keyof typeof AGENT_CONFIGS;
export const AGENT_PROFILE_NAMES = Object.freeze(
  Object.keys(AGENT_CONFIGS) as [AgentProfileName, ...AgentProfileName[]],
);

const GOOGLE_PROVIDER_PATTERN = /(?:^|[-_])(google|gemini)(?:$|[-_])/i;
const GOOGLE_MODEL_PATTERN = /^gemini(?:$|[-_.])/i;
const OFFICIAL_OPENAI_PROVIDERS = new Set([
  "openai-codex",
  "azure-openai",
  "azure-openai-responses",
]);
const OFFICIAL_ANTHROPIC_PROVIDERS = new Set([
  "anthropic-oauth",
  "amazon-bedrock",
  "aws-bedrock",
  "anthropic-vertex",
]);

function isGoogleCandidate(model: AvailableModel): boolean {
  return GOOGLE_PROVIDER_PATTERN.test(model.provider) || GOOGLE_MODEL_PATTERN.test(model.id);
}

function canonicalProvider(modelId: string): "openai" | "anthropic" | undefined {
  if (/^(?:gpt-|o[1-9](?:-|$)|chatgpt-)/i.test(modelId)) return "openai";
  if (/^claude(?:-|$)/i.test(modelId)) return "anthropic";
  return undefined;
}

function providerRank(provider: string, modelId: string): number {
  const canonical = canonicalProvider(modelId);
  if (provider === canonical) return 0;
  if (
    (canonical === "openai" && OFFICIAL_OPENAI_PROVIDERS.has(provider)) ||
    (canonical === "anthropic" && OFFICIAL_ANTHROPIC_PROVIDERS.has(provider))
  )
    return 1;
  return 2;
}

export function hasModelId(models: readonly AvailableModel[], id: string): boolean {
  return models.some((model) => model.id === id && !isGoogleCandidate(model));
}

export function firstAvailable(
  models: readonly AvailableModel[],
  ...selectors: readonly string[]
): string | undefined {
  return selectors.find((selector) => {
    try {
      resolveModelSelector(selector, models);
      return true;
    } catch {
      return false;
    }
  });
}

export function parseModelSelector(selector: string): { provider?: string; id: string } {
  const normalized = selector.trim();
  if (!normalized) throw new Error("Model selector must not be empty.");
  const slash = normalized.indexOf("/");
  if (slash === -1) return { id: normalized };
  const provider = normalized.slice(0, slash).trim();
  const id = normalized.slice(slash + 1).trim();
  if (!provider || !id)
    throw new Error(`Invalid provider-qualified model selector: ${selector}`);
  return { provider, id };
}

export function resolveModelSelector(
  selector: string,
  availableModels: readonly AvailableModel[],
): AvailableModel {
  const parsed = parseModelSelector(selector);
  const candidates = availableModels.filter(
    (model) =>
      model.id === parsed.id &&
      (!parsed.provider || model.provider === parsed.provider) &&
      !isGoogleCandidate(model),
  );
  if (!candidates.length)
    throw new Error(`Configured model is not authenticated or available: ${selector}`);
  return [...candidates].sort(
    (left, right) =>
      providerRank(left.provider, left.id) - providerRank(right.provider, right.id) ||
      left.provider.localeCompare(right.provider) ||
      left.id.localeCompare(right.id),
  )[0];
}

export function getAgentProfileNames(
  registry: Readonly<Record<string, AgentConfig>> = AGENT_CONFIGS,
): readonly string[] {
  return Object.freeze(Object.keys(registry));
}

export function getAgentProfilesDescription(
  registry: Readonly<Record<string, AgentConfig>> = AGENT_CONFIGS,
): string {
  return getAgentProfileNames(registry)
    .map((key) => {
      const config = registry[key];
      return `- \`${key}\` — ${config.description?.trim() || key} — ${config.isReadonly ? "read-only" : "write-capable"}`;
    })
    .join("\n");
}

export function resolveAgentConfig(
  key: string,
  context: ModelSelectorContext,
  registry: Readonly<Record<string, AgentConfig>> = AGENT_CONFIGS,
): ResolvedAgentConfig {
  const config = registry[key];
  if (!config) throw new Error(`Unknown agent profile: ${key}`);
  const availableModels = Object.freeze(
    context.availableModels.map((model) => Object.freeze({ provider: model.provider, id: model.id })),
  );
  const selectorContext = Object.freeze({
    availableModels,
    parentModel: Object.freeze({
      provider: context.parentModel.provider,
      id: context.parentModel.id,
    }),
  });
  const selector =
    typeof config.model === "function" ? config.model(selectorContext) : config.model;
  if (typeof selector !== "string")
    throw new Error(`Agent profile ${key} returned an invalid model selector.`);
  const selected = resolveModelSelector(selector, availableModels);
  const allowedTools = Object.freeze(
    Array.from(new Set(config.allowedTools.map((tool) => tool.trim()).filter(Boolean))),
  );
  if (!allowedTools.length) throw new Error(`Agent profile ${key} must allow at least one tool.`);
  if (!config.prompt.trim()) throw new Error(`Agent profile ${key} must define a prompt.`);
  return Object.freeze({
    key,
    allowedTools,
    provider: selected.provider,
    modelId: selected.id,
    prompt: config.prompt,
    isReadonly: config.isReadonly,
    description: config.description?.trim() || key,
    thinking: config.thinking ?? "high",
    color: config.color ?? "accent",
  });
}

const THEME_COLORS = new Set<ThemeColor>([
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
]);

export function configuredProfileColor(profile: unknown): ThemeColor {
  if (typeof profile !== "string") return "muted";
  const config = (AGENT_CONFIGS as Readonly<Record<string, AgentConfig>>)[profile];
  return config ? (config.color ?? "accent") : "muted";
}

export function persistedProfileColor(profile: unknown, color: unknown): ThemeColor {
  return typeof profile === "string" && THEME_COLORS.has(color as ThemeColor)
    ? (color as ThemeColor)
    : "muted";
}
