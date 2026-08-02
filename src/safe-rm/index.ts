import { lstat, readdir, realpath, rm as remove } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { assertUnprotectedPath } from "../shared/protected_paths";

const MAX_TARGETS = 50;

const SafeRmParams = Type.Object({
  paths: Type.Array(
    Type.String({
      description: "Literal file or directory path. Globs and shell expansion are not supported.",
      minLength: 1,
    }),
    {
      description: "Paths to remove after every target passes validation.",
      maxItems: MAX_TARGETS,
      minItems: 1,
    },
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description: "Must be true to remove directories. Defaults to false.",
    }),
  ),
});

export type SafeRmInput = Static<typeof SafeRmParams>;

interface AllowedRoot {
  lexical: string;
  canonical: string;
}

interface ValidatedTarget {
  input: string;
  absolute: string;
  missing: boolean;
  directory: boolean;
}

interface SafeRmDetails {
  removed: string[];
  missing: string[];
}

const isDescendant = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

const isWithinOrEqual = (root: string, candidate: string): boolean =>
  root === candidate || isDescendant(root, candidate);

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const normalizeInput = (path: string): string => {
  const normalized = path.startsWith("@") ? path.slice(1) : path;
  if (!normalized || normalized.startsWith("~") || normalized.includes("\0")) {
    throw new Error(`Invalid literal deletion path: ${JSON.stringify(path)}`);
  }
  return normalized;
};

const rejectMetadataPath = (absolutePath: string): void => {
  if (absolutePath.split(sep).some((component) => component.toLowerCase() === ".git")) {
    throw new Error(`Refusing to remove Git metadata: ${absolutePath}`);
  }
};

const throwIfCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {throw new Error("Deletion was cancelled");}
};

/**
 * Recursive removal must not turn a harmless-looking parent directory into
 * a way to erase credentials or a nested Git repository. Symlink entries are
 * checked by canonical policy but never traversed.
 */
const inspectDirectoryTree = async (
  directory: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> => {
  throwIfCancelled(signal);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    throwIfCancelled(signal);
    const child = join(directory, entry.name);
    if (entry.name.toLowerCase() === ".git") {
      throw new Error(`Refusing to remove a Git repository: ${directory}`);
    }
    rejectMetadataPath(child);
    await assertUnprotectedPath(child, cwd, "remove");
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await inspectDirectoryTree(child, cwd, signal);
    }
  }
};

interface ValidateTargetOptions {
  input: string;
  cwd: string;
  roots: AllowedRoot[];
  recursive: boolean;
  signal: AbortSignal | undefined;
}

const validateTarget = async ({
  input,
  cwd,
  roots,
  recursive,
  signal,
}: ValidateTargetOptions): Promise<ValidatedTarget> => {
  throwIfCancelled(signal);
  const normalizedInput = normalizeInput(input);
  const absolute = resolve(cwd, normalizedInput);
  await assertUnprotectedPath(input, cwd, "remove");
  const lexicalRoot = roots.find((root) => isDescendant(root.lexical, absolute));
  if (!lexicalRoot) {
    throw new Error(`Deletion target must be below the working directory or /tmp: ${input}`);
  }

  rejectMetadataPath(absolute);

  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) {return { absolute, directory: false, input, missing: true };}
    throw error;
  }

  const canonicalParent = await realpath(dirname(absolute));
  if (!roots.some((root) => isWithinOrEqual(root.canonical, canonicalParent))) {
    throw new Error(`Deletion target escapes an allowed root through a symlink: ${input}`);
  }

  const directory = stats.isDirectory() && !stats.isSymbolicLink();
  if (directory && !recursive) {
    throw new Error(`Directory deletion requires recursive: true: ${input}`);
  }
  if (directory) {await inspectDirectoryTree(absolute, cwd, signal);}

  return { absolute, directory, input, missing: false };
};

interface RevalidateTargetOptions {
  target: ValidatedTarget;
  roots: AllowedRoot[];
  cwd: string;
  signal: AbortSignal | undefined;
}

const revalidateTarget = async ({
  target,
  roots,
  cwd,
  signal,
}: RevalidateTargetOptions): Promise<void> => {
  throwIfCancelled(signal);
  await assertUnprotectedPath(target.absolute, cwd, "remove");
  const canonicalParent = await realpath(dirname(target.absolute));
  if (!roots.some((root) => isWithinOrEqual(root.canonical, canonicalParent))) {
    throw new Error(`Deletion target escapes an allowed root through a symlink: ${target.input}`);
  }

  const stats = await lstat(target.absolute);
  const directory = stats.isDirectory() && !stats.isSymbolicLink();
  if (directory !== target.directory) {
    throw new Error(`Deletion target changed after validation: ${target.input}`);
  }
  if (directory) {await inspectDirectoryTree(target.absolute, cwd, signal);}
};

const rejectOverlappingTargets = (targets: ValidatedTarget[]): void => {
  for (const [index, first] of targets.entries()) {
    for (const second of targets.slice(index + 1)) {
      if (
        first.absolute === second.absolute ||
        isDescendant(first.absolute, second.absolute) ||
        isDescendant(second.absolute, first.absolute)
      ) {
        throw new Error(
          `Deletion targets must be distinct and non-overlapping: ${first.input}, ${second.input}`,
        );
      }
    }
  }
};

export default function safeRm(pi: ExtensionAPI) {
  pi.registerTool({
    description:
      "Safely remove literal paths without shell rm. Every target is validated before deletion: targets must be below the working directory or /tmp, parent symlinks cannot escape those roots, credentials and Git repositories are protected even inside recursive targets, and directories require recursive=true.",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfCancelled(signal);

      const cwd = resolve(ctx.cwd);
      const roots: AllowedRoot[] = [
        { canonical: await realpath(cwd), lexical: cwd },
        { canonical: await realpath("/tmp"), lexical: resolve("/tmp") },
      ];
      const recursive = params.recursive ?? false;
      const targets = await Promise.all(
        params.paths.map((path) => validateTarget({ cwd, input: path, recursive, roots, signal })),
      );
      rejectOverlappingTargets(targets);

      const details: SafeRmDetails = { missing: [], removed: [] };
      for (const target of targets) {
        if (target.missing) {
          details.missing.push(target.input);
          continue;
        }
        throwIfCancelled(signal);

        await withFileMutationQueue(target.absolute, async () => {
          await revalidateTarget({ cwd, roots, signal, target });
          await remove(target.absolute, { force: false, recursive: target.directory });
        });
        details.removed.push(target.input);
      }

      const lines = [
        details.removed.length > 0 ? `Removed: ${details.removed.join(", ")}` : "Removed: none",
        details.missing.length > 0
          ? `Already missing: ${details.missing.join(", ")}`
          : "Already missing: none",
      ];
      return {
        content: [{ text: lines.join("\n"), type: "text" }],
        details,
      };
    },
    label: "Safe Remove",
    name: "safe_rm",
    parameters: SafeRmParams,
    promptGuidelines: [
      "Use safe_rm for file and directory deletion. A best-effort shell scanner blocks recognized rm, rmdir, unlink, find deletion, and xargs rm commands, but safe_rm is the security-enforcing path.",
      "Set recursive=true only when intentionally removing directories. safe_rm validates all paths before deleting any of them.",
    ],
    promptSnippet: "Remove files or directories through validated literal paths",
  });
}
