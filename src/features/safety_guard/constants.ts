type Severity = 'critical' | 'high'
type Category = 'database' | 'docker' | 'filesystem' | 'git' | 'package' | 'secrets' | 'system'

interface DangerousPattern {
  pattern: RegExp
  label: string
  category: Category
  severity: Severity
}

const CRITICAL_PATTERNS = [
  {
    category: 'filesystem',
    label: 'Complex shell deletion is disabled; use the self-validating safe_rm tool instead',
    pattern:
      /(?:^|[;&|(\n])\s*(?:(?:(?:\/(?:usr\/)?bin\/)?(?:busybox|command|env|exec|nice|nohup|sudo|timeout)\b[^\n;&|]*?\s+)+)?(?:\/(?:usr\/)?bin\/)?(?:rm|rmdir|unlink)\b|\b(?:bash|fish|ksh|sh|zsh)\s+-c\s+['"][^'"]*\b(?:rm|rmdir|unlink)\b|\b(?:do|then)\s+(?:\/(?:usr\/)?bin\/)?(?:rm|rmdir|unlink)\b|\bfind\b[^\n;&|]*(?:-delete\b|-exec\s+rm\b)|\bxargs\b[^\n;&|]*\brm\b/i,
    severity: 'critical',
  },
  {
    category: 'filesystem',
    label: 'Write to raw disk device',
    pattern: />\s*\/dev\/(?:disk|hd|nvme|sd|vd)[^\s;&|]*/i,
    severity: 'critical',
  },
  {
    category: 'filesystem',
    label: 'dd to device',
    pattern: /\bdd\b[^\n;&|]*\bof=\/dev\//i,
    severity: 'critical',
  },
  {
    category: 'filesystem',
    label: 'Format or partition storage',
    pattern: /\b(?:mkfs(?:\.|\b)|wipefs\b|diskutil\s+(?:erase|partition)|(?:s|s?g)?fdisk\b|parted\b)/i,
    severity: 'critical',
  },
  {
    category: 'system',
    label: 'Fork bomb',
    pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/i,
    severity: 'critical',
  },
  {
    category: 'system',
    label: 'System shutdown/reboot',
    pattern: /\b(?:halt|poweroff|reboot|shutdown)\b/i,
    severity: 'critical',
  },
  {
    category: 'system',
    label: 'Flush firewall rules',
    pattern: /\b(?:ip6tables|iptables)\s+-F\b/i,
    severity: 'critical',
  },
  {
    category: 'git',
    label: 'Git force push',
    pattern:
      /\bgit\b(?:[ \t]+(?:(?:-C|-c|--(?:config-env|git-dir|namespace|super-prefix|work-tree))(?:=[^\s;&|]+|[ \t]+[^\s;&|]+)|--[^\s;&|]+|-[pP]))*[ \t]+push\b[^\n;&|]*[ \t]+["']?(?:--force|-(?!-)[46dnquv]*f[46dnquv]*)["']?(?=$|[\s;&|])/i,
    severity: 'critical',
  },
] as const satisfies readonly DangerousPattern[]

const HIGH_PATTERNS = [
  {
    category: 'filesystem',
    label: 'Destructive file operation',
    pattern: /\b(?:shred\b|truncate\s+-s\s+0\b|dd\b)/i,
    severity: 'high',
  },
  {
    category: 'docker',
    label: 'Container/image/volume removal',
    pattern: /\b(?:docker|podman)\s+(?:rm|rmi)\b|\b(?:docker|podman)\s+(?:system|volume)\s+prune\b/i,
    severity: 'high',
  },
  {
    category: 'docker',
    label: 'Docker Compose volume removal',
    pattern: /\bdocker(?:-compose|\s+compose)\s+down\b[^\n;&|]*(?:-v|--volumes)\b/i,
    severity: 'high',
  },
  {
    category: 'package',
    label: 'Package removal',
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm|prune|autoclean)\b|\b(?:cargo|pip|uv)\s+(?:remove|uninstall)\b/i,
    severity: 'high',
  },
  {
    category: 'package',
    label: 'System package removal',
    pattern: /\b(?:apt(?:-get)?\s+(?:autoremove|purge|remove)|dnf\s+remove|(?:pacman|paru|yay)\s+-R)/i,
    severity: 'high',
  },
  {
    category: 'system',
    label: 'Elevated privileges (sudo)',
    pattern: /\bsudo\b/i,
    severity: 'high',
  },
  {
    category: 'system',
    label: 'Dangerous permission change',
    pattern: /\b(?:chmod|chown)\b[^\n;&|]*(?:\s-R\b|\b777\b)/i,
    severity: 'high',
  },
  {
    category: 'system',
    label: 'Force process termination',
    pattern: /\b(?:killall\b|pkill\s+-9\b|kill\s+-9\b)/i,
    severity: 'high',
  },
  {
    category: 'system',
    label: 'System service change',
    pattern: /\b(?:launchctl\s+(?:remove|unload)|systemctl\s+(?:disable|mask|restart|stop))\b/i,
    severity: 'high',
  },
  {
    category: 'system',
    label: 'System mount/permission change',
    pattern: /\b(?:mount|setfacl|swapoff|swapon|umount)\b/i,
    severity: 'high',
  },
  {
    category: 'database',
    label: 'Destructive SQL schema operation',
    pattern: /\bDROP\s+(?:DATABASE|INDEX|SCHEMA|TABLE)\b|\bTRUNCATE\s+(?:TABLE\s+)?[\w.`"[\]-]+/i,
    severity: 'high',
  },
  {
    category: 'database',
    label: 'Unscoped SQL data mutation',
    pattern: /\bDELETE\s+FROM\b(?:(?!\bWHERE\b|;)[\s\S])*(?:;|$)|\bUPDATE\s+[\w.`"[\]-]+\s+SET\b(?:(?!\bWHERE\b|;)[\s\S])*(?:;|$)/i,
    severity: 'high',
  },
  {
    category: 'database',
    label: 'Destructive SQL table alteration',
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i,
    severity: 'high',
  },
  {
    category: 'secrets',
    label: 'Possible secret file access',
    pattern:
      /\b(?:awk|cat|cp|grep|rg|sed)\b[^\n;&|]*(?:\.aws\/(?:config|credentials)|\.config\/(?:gcloud|gh\/hosts\.yml)|\.docker\/config\.json|\.env(?:\.[^\s;&|]+)?|\.git-credentials|\.kube\/config|\.netrc|\.npmrc|\.pypirc|auth\.json|id_(?:ed25519|rsa)|\.(?:kdbx|key|p12|pem)\b)/i,
    severity: 'high',
  },
] as const satisfies readonly DangerousPattern[]

export const ALL_PATTERNS = [...CRITICAL_PATTERNS, ...HIGH_PATTERNS] as const satisfies readonly DangerousPattern[]

export const COMMAND_EXCERPT_CONTEXT_LINES = 2
export const COMMAND_EXCERPT_MAX_LENGTH = 240
export const SAFETY_STATUS_KEY = 'safety-cmds'
