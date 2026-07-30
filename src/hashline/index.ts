import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatHashlineHeader,
  formatNumberedLines,
  InMemorySnapshotStore,
  NodeFilesystem,
  normalizeToLF,
  Patch,
  Patcher,
} from "@oh-my-pi/hashline";
import { relative } from "node:path";
import { Type } from "typebox";
import {
  assertUnprotectedPath,
  resolveToolPath,
  stripToolPathPrefix,
} from "../shared/protected-paths";

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read." }),
});

const writeSchema = Type.Object({
  patch: Type.String({
    description:
      "A hashline patch. Start with [path#TAG], then use SWAP N.=M: with +replacement rows, DEL N.=M, or INS.PRE/POST N: with +inserted rows. Unified-diff @@ hunks are invalid.",
  }),
});

function result(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Hashline operation aborted");
}

/** Keep every path used internally by hashline rooted in the tool context. */
class CwdFilesystem extends NodeFilesystem {
  constructor(
    private readonly cwd: string,
    private readonly signal: AbortSignal | undefined,
  ) {
    super();
  }

  private absolute(path: string): string {
    return resolveToolPath(path, this.cwd);
  }

  override async readText(path: string): Promise<string> {
    throwIfAborted(this.signal);
    const text = await super.readText(this.absolute(path));
    throwIfAborted(this.signal);
    return text;
  }

  override async readBinary(path: string): Promise<Uint8Array> {
    throwIfAborted(this.signal);
    const bytes = await super.readBinary(this.absolute(path));
    throwIfAborted(this.signal);
    return bytes;
  }

  override async writeText(path: string, content: string) {
    throwIfAborted(this.signal);
    const written = await super.writeText(this.absolute(path), content);
    throwIfAborted(this.signal);
    return written;
  }

  override async delete(path: string): Promise<void> {
    throwIfAborted(this.signal);
    await super.delete(this.absolute(path));
    throwIfAborted(this.signal);
  }

  override async move(from: string, to: string, content?: string): Promise<void> {
    throwIfAborted(this.signal);
    await super.move(this.absolute(from), this.absolute(to), content);
    throwIfAborted(this.signal);
  }

  override canonicalPath(path: string): string {
    return this.absolute(path);
  }

  override async exists(path: string): Promise<boolean> {
    throwIfAborted(this.signal);
    return super.exists(this.absolute(path));
  }

  // Tag recovery can redirect a patch to a path not listed in its headers.
  // Disabling it is necessary so policy checks and mutation locks cover every
  // file that the custom tool can affect.
  override allowTagPathRecovery(): boolean {
    return false;
  }
}

async function withMutationQueues<T>(
  paths: readonly string[],
  callback: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  const acquire = (index: number): Promise<T> => {
    const path = ordered[index];
    return path === undefined ? callback() : withFileMutationQueue(path, () => acquire(index + 1));
  };
  return acquire(0);
}

export default function hashline(pi: ExtensionAPI) {
  const snapshots = new InMemorySnapshotStore();

  pi.registerTool({
    name: "hashline_read",
    label: "Hashline Read",
    description:
      "Read a file with stable line anchors and a content hash for hashline_write. Use this instead of read before editing a file with hashline. Protected credential paths are refused by this tool itself.",
    parameters: readSchema,
    async execute(_toolCallId, { path }, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const resolution = await assertUnprotectedPath(path, ctx.cwd, "read");
      const fs = new CwdFilesystem(ctx.cwd, signal);
      const text = await fs.readText(resolution.absolutePath);
      const normalized = normalizeToLF(text);
      const tag = snapshots.record(resolution.absolutePath, normalized);
      const displayPath = relative(ctx.cwd, resolution.absolutePath) || ".";

      return result(
        `${formatHashlineHeader(displayPath, tag)}\n${formatNumberedLines(normalized)}`,
        { path: displayPath, hash: tag },
      );
    },
  });

  pi.registerTool({
    name: "hashline_write",
    label: "Hashline Write",
    description:
      "Apply a hashline patch produced from hashline_read. Use hashline operations (SWAP, DEL, or INS), not unified-diff @@ hunks. Patches are content-hash anchored, reject stale edits, and refuse protected credential paths.",
    parameters: writeSchema,
    promptGuidelines: [
      "Use hashline_read before hashline_write so every section has a current [path#TAG] anchor.",
      "In hashline_write, replace lines with `SWAP N.=M:` followed by `+` body rows; never use unified-diff `@@` headers.",
      "Use hashline_write for targeted edits; use the built-in write tool when creating a new file from scratch.",
    ],
    async execute(_toolCallId, { patch }, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const parsed = Patch.parse(patch, { cwd: ctx.cwd });
      const affectedPaths: string[] = [];
      for (const section of parsed.sections) {
        affectedPaths.push(stripToolPathPrefix(section.path));
        const fileOp = section.fileOp;
        if (fileOp?.kind === "move") affectedPaths.push(stripToolPathPrefix(fileOp.dest));
      }
      if (affectedPaths.length === 0) throw new Error("Hashline patch contains no file sections");

      // Resolve policy and lock keys before acquiring anything. Canonical keys
      // make aliases take the same lock; sorting prevents multi-file deadlocks.
      const lockPaths: string[] = [];
      for (const path of affectedPaths) {
        const checked = await assertUnprotectedPath(path, ctx.cwd, "write");
        lockPaths.push(checked.canonicalPath);
      }

      return withMutationQueues(lockPaths, async () => {
        throwIfAborted(signal);
        // Re-evaluate after waiting: a parent may have been replaced by a
        // symlink while this operation was queued.
        for (const path of affectedPaths) {
          await assertUnprotectedPath(path, ctx.cwd, "write");
        }
        throwIfAborted(signal);

        const fs = new CwdFilesystem(ctx.cwd, signal);
        const patcher = new Patcher({ fs, snapshots });
        const applied = await patcher.apply(parsed);
        throwIfAborted(signal);
        const summary = applied.sections.map((section) => {
          const target = relative(ctx.cwd, section.canonicalPath) || section.canonicalPath;
          return `${section.op} ${target} [${section.fileHash}]`;
        });

        return result(summary.join("\n"), { sections: applied.sections });
      });
    },
  });
}
