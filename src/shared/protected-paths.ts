import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/** Filenames that look like dotenv files but are intended to be public examples. */
export const PUBLIC_ENV_FILENAMES = new Set([".env.example", ".env.sample", ".env.template"]);

const ALWAYS_PROTECTED_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)(?:\.envrc|\.git-credentials|\.netrc|\.npmrc|\.pypirc|auth\.json)$/,
  /(^|\/)id_(?:ed25519|rsa)(?:\.pub)?$/,
  /(^|\/)\.aws\/(?:config|credentials)$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.config\/(?:gcloud(?:\/|$)|gh\/hosts\.yml$)/,
  /\.(?:kdbx|key|p12|pem)$/,
];

export interface ProtectedPathResolution {
  /** Absolute path after resolving it lexically against cwd. */
  absolutePath: string;
  /** Absolute path after resolving symlinks in the nearest existing ancestor. */
  canonicalPath: string;
  protected: boolean;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

/** Strip the leading `@` accepted by pi's path-oriented tools. */
export function stripToolPathPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

export function resolveToolPath(path: string, cwd: string): string {
  return resolve(cwd, stripToolPathPrefix(path));
}

/**
 * Canonicalize an existing path, or (for a path that does not exist yet)
 * canonicalize its nearest existing ancestor and append the missing suffix.
 * This prevents `link-to-elsewhere/new-file` from evading path policy merely
 * because `new-file` has not been created yet.
 */
export async function canonicalizeNearestExisting(path: string): Promise<string> {
  let candidate = resolve(path);
  const missingComponents: string[] = [];

  while (true) {
    try {
      const existing = await realpath(candidate);
      return resolve(existing, ...missingComponents);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      missingComponents.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function matchesProtectedPolicy(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  const isPrivateEnv =
    (name === ".env" || name.startsWith(".env.")) && !PUBLIC_ENV_FILENAMES.has(name);
  return isPrivateEnv || ALWAYS_PROTECTED_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Apply protected-file policy to both the lexical and canonical spellings.
 * Checking both means neither a harmless-looking symlink to a credential nor
 * a credential-shaped symlink to a harmless file bypasses the policy.
 */
export async function resolveProtectedPath(
  path: string,
  cwd: string,
): Promise<ProtectedPathResolution> {
  const absolutePath = resolveToolPath(path, cwd);
  const canonicalPath = await canonicalizeNearestExisting(absolutePath);
  return {
    absolutePath,
    canonicalPath,
    protected: matchesProtectedPolicy(absolutePath) || matchesProtectedPolicy(canonicalPath),
  };
}

export async function isProtectedPath(path: string, cwd: string): Promise<boolean> {
  return (await resolveProtectedPath(path, cwd)).protected;
}

export async function assertUnprotectedPath(
  path: string,
  cwd: string,
  operation: string,
): Promise<ProtectedPathResolution> {
  const resolution = await resolveProtectedPath(path, cwd);
  if (resolution.protected) {
    throw new Error(`Refusing to ${operation} protected path: ${path}`);
  }
  return resolution;
}
