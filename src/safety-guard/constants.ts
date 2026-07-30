export type Severity = "critical" | "high";
export type Category =
  | "database"
  | "docker"
  | "filesystem"
  | "git"
  | "package"
  | "secrets"
  | "system";

export interface DangerousPattern {
  pattern: RegExp;
  label: string;
  category: Category;
  severity: Severity;
}

export const CRITICAL_PATTERNS: DangerousPattern[] = [
  {
    pattern:
      /(?:^|[;&|(\n])\s*(?:(?:(?:\/(?:usr\/)?bin\/)?(?:busybox|command|env|exec|nice|nohup|sudo|timeout)\b[^\n;&|]*?\s+)+)?(?:\/(?:usr\/)?bin\/)?(?:rm|rmdir|unlink)\b|\b(?:bash|fish|ksh|sh|zsh)\s+-c\s+['"][^'"]*\b(?:rm|rmdir|unlink)\b|\b(?:do|then)\s+(?:\/(?:usr\/)?bin\/)?(?:rm|rmdir|unlink)\b|\bfind\b[^\n;&|]*(?:-delete\b|-exec\s+rm\b)|\bxargs\b[^\n;&|]*\brm\b/i,
    label: "Recognized shell deletion is disabled; use the self-validating safe_rm tool instead",
    category: "filesystem",
    severity: "critical",
  },
  {
    pattern: />\s*\/dev\/(?:disk|hd|nvme|sd|vd)[^\s;&|]*/i,
    label: "Write to raw disk device",
    category: "filesystem",
    severity: "critical",
  },
  {
    pattern: /\bdd\b[^\n;&|]*\bof=\/dev\//i,
    label: "dd to device",
    category: "filesystem",
    severity: "critical",
  },
  {
    pattern:
      /\b(?:mkfs(?:\.|\b)|wipefs\b|diskutil\s+(?:erase|partition)|(?:s|s?g)?fdisk\b|parted\b)/i,
    label: "Format or partition storage",
    category: "filesystem",
    severity: "critical",
  },
  {
    pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/i,
    label: "Fork bomb",
    category: "system",
    severity: "critical",
  },
  {
    pattern: /\b(?:halt|poweroff|reboot|shutdown)\b/i,
    label: "System shutdown/reboot",
    category: "system",
    severity: "critical",
  },
  {
    pattern: /\b(?:ip6tables|iptables)\s+-F\b/i,
    label: "Flush firewall rules",
    category: "system",
    severity: "critical",
  },
];

const HIGH_PATTERNS: DangerousPattern[] = [
  {
    pattern: /\b(?:shred\b|truncate\s+-s\s+0\b|dd\b)/i,
    label: "Destructive file operation",
    category: "filesystem",
    severity: "high",
  },
  {
    pattern: /\bgit\s+reset\s+(?:--hard|--merge|--keep|HEAD[~^]|[a-f0-9]{7,40}\b)/i,
    label: "Git reset/history rewrite",
    category: "git",
    severity: "high",
  },
  {
    pattern: /\bgit\s+clean\b[^\n;&|]*\s-[^\s;&|]*f/i,
    label: "Git clean",
    category: "git",
    severity: "high",
  },
  {
    pattern: /\bgit\s+(?:checkout\s+--\s+|restore\b|branch\s+-[dD]\b|tag\s+-d\b)/i,
    label: "Destructive Git working-tree/ref operation",
    category: "git",
    severity: "high",
  },
  {
    pattern: /\bgit\s+(?:rebase\b|filter-(?:branch|repo)\b|replace\b|update-ref\b|prune\b)/i,
    label: "Git history rewrite",
    category: "git",
    severity: "high",
  },
  {
    pattern:
      /\bgit\s+(?:push\b[^\n;&|]*(?:--force(?:-with-lease)?|--delete|:refs\/heads\/)|commit\b[^\n;&|]*--(?:amend|fixup|squash)\b)/i,
    label: "Git history/ref mutation",
    category: "git",
    severity: "high",
  },
  {
    pattern:
      /\b(?:docker|podman)\s+(?:rm|rmi)\b|\b(?:docker|podman)\s+(?:system|volume)\s+prune\b/i,
    label: "Container/image/volume removal",
    category: "docker",
    severity: "high",
  },
  {
    pattern: /\bdocker(?:-compose|\s+compose)\s+down\b[^\n;&|]*(?:-v|--volumes)\b/i,
    label: "Docker Compose volume removal",
    category: "docker",
    severity: "high",
  },
  {
    pattern:
      /\b(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm|prune|autoclean)\b|\b(?:cargo|pip|uv)\s+(?:remove|uninstall)\b/i,
    label: "Package removal",
    category: "package",
    severity: "high",
  },
  {
    pattern:
      /\b(?:apt(?:-get)?\s+(?:autoremove|purge|remove)|dnf\s+remove|(?:pacman|paru|yay)\s+-R)/i,
    label: "System package removal",
    category: "package",
    severity: "high",
  },
  {
    pattern: /\bsudo\b/i,
    label: "Elevated privileges (sudo)",
    category: "system",
    severity: "high",
  },
  {
    pattern: /\b(?:chmod|chown)\b[^\n;&|]*(?:\s-R\b|\b777\b)/i,
    label: "Dangerous permission change",
    category: "system",
    severity: "high",
  },
  {
    pattern: /\b(?:killall\b|pkill\s+-9\b|kill\s+-9\b)/i,
    label: "Force process termination",
    category: "system",
    severity: "high",
  },
  {
    pattern: /\b(?:launchctl\s+(?:remove|unload)|systemctl\s+(?:disable|mask|restart|stop))\b/i,
    label: "System service change",
    category: "system",
    severity: "high",
  },
  {
    pattern: /\b(?:mount|setfacl|swapoff|swapon|umount)\b/i,
    label: "System mount/permission change",
    category: "system",
    severity: "high",
  },
  {
    pattern: /\bDROP\s+(?:DATABASE|INDEX|SCHEMA|TABLE)\b|\bTRUNCATE\s+(?:TABLE\s+)?[\w.`"[\]-]+/i,
    label: "Destructive SQL schema operation",
    category: "database",
    severity: "high",
  },
  {
    pattern:
      /\bDELETE\s+FROM\b(?:(?!\bWHERE\b|;)[\s\S])*(?:;|$)|\bUPDATE\s+[\w.`"[\]-]+\s+SET\b(?:(?!\bWHERE\b|;)[\s\S])*(?:;|$)/i,
    label: "Unscoped SQL data mutation",
    category: "database",
    severity: "high",
  },
  {
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i,
    label: "Destructive SQL table alteration",
    category: "database",
    severity: "high",
  },
  {
    pattern:
      /\b(?:awk|cat|cp|grep|rg|sed)\b[^\n;&|]*(?:\.aws\/(?:config|credentials)|\.config\/(?:gcloud|gh\/hosts\.yml)|\.env(?:\.[^\s;&|]+)?|\.git-credentials|\.kube\/config|\.netrc|\.npmrc|\.pypirc|auth\.json|id_(?:ed25519|rsa)|\.(?:kdbx|key|p12|pem)\b)/i,
    label: "Possible secret file access",
    category: "secrets",
    severity: "high",
  },
];

export const ALL_PATTERNS = [...CRITICAL_PATTERNS, ...HIGH_PATTERNS];

export const COMMAND_EXCERPT_CONTEXT_LINES = 2;
export const COMMAND_EXCERPT_MAX_LENGTH = 240;
export const SAFETY_STATUS_KEY = "safety-cmds";
