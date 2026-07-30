/**
 * ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: arrow keys or number keys to pick, Enter to confirm
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;

const OptionSchema = Type.Object({
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
});

const AskUserParams = Type.Object({
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;

interface AskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom: boolean;
  cancelled: boolean;
}

type SelectionResult = {
  answer: string;
  wasCustom: boolean;
  index?: number;
} | null;

interface DisplayOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (text: string, answer: string | null = null, wasCustom = false) => ({
        content: [{ type: "text" as const, text }],
        details: {
          question: params.question,
          options: params.options.map((o) => o.label),
          answer,
          wasCustom,
          cancelled: answer === null,
        } satisfies AskUserDetails,
      });

      if (params.options.length < MIN_OPTIONS || params.options.length > MAX_OPTIONS) {
        throw new Error(
          `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
        );
      }

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }

      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const allOptions: DisplayOption[] = [
        ...params.options,
        { label: "Write my own answer…", isOther: true },
      ];

      const showQuestion = (uiSignal: AbortSignal | undefined) =>
        ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
          let optionIndex = 0;
          let editMode = false;
          let cachedLines: string[] | undefined;
          let cachedWidth: number | undefined;

          let settled = false;

          function finish(result: SelectionResult) {
            if (settled) return;
            settled = true;
            uiSignal?.removeEventListener("abort", cancel);
            done(result);
          }

          function cancel() {
            finish(null);
          }

          uiSignal?.addEventListener("abort", cancel, { once: true });
          if (uiSignal?.aborted) queueMicrotask(cancel);

          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);

          editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (trimmed) {
              finish({ answer: trimmed, wasCustom: true });
            } else {
              editMode = false;
              editor.setText("");
              refresh();
            }
          };

          function refresh() {
            cachedLines = undefined;
            cachedWidth = undefined;
            tui.requestRender();
          }

          function selectOption(index: number) {
            const selected = allOptions[index];
            if (selected.isOther) {
              optionIndex = index;
              editMode = true;
              refresh();
            } else {
              finish({
                answer: selected.label,
                wasCustom: false,
                index: index + 1,
              });
            }
          }

          function handleInput(data: string) {
            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                editMode = false;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (matchesKey(data, Key.up)) {
              optionIndex = (optionIndex - 1 + allOptions.length) % allOptions.length;
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = (optionIndex + 1) % allOptions.length;
              refresh();
              return;
            }

            // Number keys jump straight to an option
            if (data.length === 1 && data >= "1" && data <= String(allOptions.length)) {
              selectOption(Number(data) - 1);
              return;
            }

            if (matchesKey(data, Key.enter)) {
              selectOption(optionIndex);
              return;
            }

            if (matchesKey(data, Key.escape)) {
              finish(null);
            }
          }

          function render(width: number): string[] {
            const renderWidth = Math.max(1, Math.floor(width));
            if (cachedLines && cachedWidth === renderWidth) return cachedLines;

            const lines: string[] = [];
            const add = (s: string) => lines.push(truncateToWidth(s, renderWidth));
            const addWrapped = (text: string, indent: string, style: (value: string) => string) => {
              const safeIndent = visibleWidth(indent) < renderWidth ? indent : "";
              const contentWidth = Math.max(1, renderWidth - visibleWidth(safeIndent));
              for (const line of wrapTextWithAnsi(text, contentWidth)) {
                add(safeIndent + style(line));
              }
            };

            const title = " Question ";
            const ruleWidth = Math.max(0, renderWidth - visibleWidth(title) - 1);
            add(theme.fg("accent", `─${title}${"─".repeat(ruleWidth)}`));
            addWrapped(params.question, " ", (line) => theme.fg("text", theme.bold(line)));
            lines.push("");

            for (let i = 0; i < allOptions.length; i++) {
              const opt = allOptions[i];
              const selected = i === optionIndex;
              const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
              const marker = opt.isOther ? "✎" : `${i + 1}.`;
              const label = `${marker} ${opt.label}`;
              const color =
                selected || (opt.isOther && editMode) ? "accent" : opt.isOther ? "muted" : "text";

              addWrapped(label, prefix, (line) => theme.fg(color, line));

              if (opt.description) {
                addWrapped(opt.description, "      ", (line) => theme.fg("muted", line));
              }
            }

            if (editMode) {
              lines.push("");
              add(theme.fg("muted", " Your answer:"));
              const editorIndent = renderWidth > 1 ? " " : "";
              const editorWidth = Math.max(1, renderWidth - visibleWidth(editorIndent));
              for (const line of editor.render(editorWidth)) {
                add(editorIndent + line);
              }
            }

            lines.push("");
            if (editMode) {
              add(theme.fg("dim", " Enter submit • Esc back to options"));
            } else {
              add(
                theme.fg(
                  "dim",
                  ` ↑↓ or 1-${allOptions.length} select • Enter confirm • Esc dismiss`,
                ),
              );
            }
            add(theme.fg("accent", "─".repeat(renderWidth)));

            cachedLines = lines;
            cachedWidth = renderWidth;
            return lines;
          }

          let focused = false;
          return {
            get focused() {
              return focused;
            },
            set focused(value: boolean) {
              focused = value;
              editor.focused = value;
              cachedLines = undefined;
              cachedWidth = undefined;
            },
            render,
            invalidate: () => {
              cachedLines = undefined;
              cachedWidth = undefined;
            },
            handleInput,
            dispose: () => {
              uiSignal?.removeEventListener("abort", cancel);
            },
          } satisfies Component & Focusable & { dispose(): void };
        });

      const result = await showQuestion(signal ?? undefined);

      if (!result) {
        const kind = signal?.aborted ? "cancelled" : "dismissed";
        return reply(buildAskUserResultMessage({ kind }));
      }

      if (result.wasCustom) {
        return reply(
          buildAskUserResultMessage({
            kind: "custom",
            answer: result.answer,
          }),
          result.answer,
          true,
        );
      }

      return reply(
        buildAskUserResultMessage({
          kind: "selected",
          answer: result.answer,
          index: result.index,
        }),
        result.answer,
      );
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg("muted", typeof args.question === "string" ? args.question : "");
      const opts = Array.isArray(args.options) ? (args.options as DisplayOption[]) : [];
      if (opts.length > 0) {
        const numbered = opts.map((o, i) => `${i + 1}. ${o.label}`);
        text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      if (details.cancelled || details.answer === null) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }

      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", details.answer),
          0,
          0,
        );
      }

      const idx = details.options.indexOf(details.answer) + 1;
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
      return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
    },
  });
}
