// Command-policy helpers. The denylist below is migrated (2026-08-19) from
// mcp-ssh-manager `src/policy.js` READONLY_DENY_REGEX. It is a guard rail against
// accidental destructive or prompt-injected commands — NOT a security boundary.

export const REVIEW_LEVELS = ['normal', 'strict']

export function normalizeReview(value) {
  if (value === undefined || value === null || value === '') return 'normal'
  const s = String(value).toLowerCase().trim()
  return REVIEW_LEVELS.includes(s) ? s : 'normal'
}

// Built-in destructive-command patterns: word-boundary anchored, pipeline and
// redirect aware. Applied only to hosts whose review level opts into it (Phase 1
// keeps this table ready for the strict/restricted hardening; the core strict
// flow is approval, not filtering).
export const DESTRUCTIVE_PATTERNS = [
  /(^|[\s;&|])rm(\s|$)/,
  /(^|[\s;&|])rmdir(\s|$)/,
  /(^|[\s;&|])mv(\s|$)/,
  /(^|[\s;&|])dd(\s|$)/,
  /(^|[\s;&|])mkfs(\.|\s|$)/,
  /(^|[\s;&|])chmod(\s|$)/,
  /(^|[\s;&|])chown(\s|$)/,
  /(^|[\s;&|])truncate(\s|$)/,
  /(^|[\s;&|])tee(\s|$)/,
  /(^|[\s;&|])sudo(\s|$)/,
  /(^|[\s;&|])su(\s|$)/,
  /(^|[\s;&|])kill(\s|$)/,
  /(^|[\s;&|])pkill(\s|$)/,
  /(^|[\s;&|])killall(\s|$)/,
  /(^|[\s;&|])shutdown(\s|$)/,
  /(^|[\s;&|])reboot(\s|$)/,
  /(^|[\s;&|])halt(\s|$)/,
  /(^|[\s;&|])poweroff(\s|$)/,
  /(^|[\s;&|])systemctl\s+(restart|stop|reload|start|enable|disable|mask)/,
  /(^|[\s;&|])service\s+\S+\s+(restart|stop|reload|start)/,
  /(^|[\s;&|])docker\s+(rm|stop|restart|kill|prune|system)/,
  /(^|[\s;&|])apt(-get)?\s+(install|remove|purge|upgrade|update)/,
  /(^|[\s;&|])yum\s+(install|remove|update|upgrade)/,
  /(^|[\s;&|])dnf\s+(install|remove|update|upgrade)/,
  /(^|[\s;&|])pip\s+(install|uninstall)/,
  /(^|[\s;&|])npm\s+(install|uninstall|publish)/,
  /(^|[\s;&|])git\s+(reset\s+--hard|push\s+.*--force|clean\s+-fd?)/,
  />\s*\/(?!dev\/null|dev\/stdout|dev\/stderr|tmp)/,
  />>\s*\/(?!dev\/null|tmp)/,
  /\|\s*sh(\s|$)/,
  /\|\s*bash(\s|$)/,
  /curl\s+[^|]*\|\s*(sh|bash)/,
  /wget\s+[^|]*\|\s*(sh|bash)/,
]

export function isDestructive(command) {
  if (typeof command !== 'string') return false
  for (const re of DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) return true
  }
  return false
}