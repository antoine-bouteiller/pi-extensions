import { homedir } from "node:os";
import { relative } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}
export interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

type Rgb = [number, number, number];
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
export const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
// oxlint-disable no-control-regex -- ANSI escape sequence matcher.
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// oxlint-enable no-control-regex

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}
function sampleGradient(position: number) {
  const scaled = (((position % 1) + 1) % 1) * PALETTE.length;
  const index = Math.floor(scaled);
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[(index + 1) % PALETTE.length]!;
  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}
function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}
export function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);
  return characters
    .map((character, index) =>
      character === " " ? character : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}
function hasChildren(
  component: RenderableNode,
): component is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(component.children);
}
function renderedText(component: RenderableNode) {
  try {
    return component.render(200).join("\n").replace(ANSI_PATTERN, "");
  } catch {
    return "";
  }
}
export function hideThemesSection(component: RenderableNode): boolean {
  if (!hasChildren(component)) return false;
  for (let index = 0; index < component.children.length; index += 1) {
    const child = component.children[index]!;
    const firstLine = renderedText(child)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
    if (firstLine === "[Themes]") {
      const removeCount =
        component.children[index + 1] && renderedText(component.children[index + 1]!).trim() === ""
          ? 2
          : 1;
      component.children.splice(index, removeCount);
      component.invalidate();
      return true;
    }
    if (hideThemesSection(child)) return true;
  }
  return false;
}
export function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
export function progressBar(percent: number, width: number) {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return `${"▓".repeat(filled)}${"░".repeat(width - filled)}`;
}
export function progressLine(label: string, percent: number, detail: string, width = 10) {
  return `${label}: ${progressBar(percent, width)} ${percent.toFixed(1)}%${detail ? `  ${detail}` : ""}`;
}
export function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}
export function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}
export function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);
  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;
  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, Math.max(1, width - leftWidth - 1));
  const gap = Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
  return truncateToWidth(`${fittedLeft}${" ".repeat(gap)}${fittedRight}`, width);
}
