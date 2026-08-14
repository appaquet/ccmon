/**
 * Named time/millisecond constants shared across ccmon modules.
 *
 * All values in milliseconds unless suffixed with _BYTES.
 */

/** Sub-agents whose JSONL was modified within this window are considered active. */
export const SUBAGENT_ACTIVE_THRESHOLD_MS = 15_000;

/** Sub-agents older than this since last JSONL mtime are pruned. */
export const SUBAGENT_EXPIRY_MS = 30_000;

/** Linked OpenCode sub-agents without a terminal signal are retained for this long. */
export const SUBAGENT_LIFECYCLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Grace period after a sub-agent's Stop event before its JSONL mtime is checked. */
export const SUBAGENT_STOP_GRACE_MS = 5_000;

/** JSONL mtime within this window indicates an active session. */
export const JSONL_ACTIVE_THRESHOLD_MS = 60_000;

/** OpenCode session considered active if its latest activity is within this window. */
export const OPENCODE_ACTIVE_THRESHOLD_MS = 30_000;

/** Interval at which the server rescans backends and broadcasts state to WebSocket clients. */
export const BROADCAST_INTERVAL_MS = 50_000;

/** Plugin heartbeat older than this marks the plugin unhealthy (3× the 30s cadence). */
export const PLUGIN_HEALTH_THRESHOLD_MS = 90_000;

/** Time to keep a closed project in the filtered state view before removal. */
export const CLOSED_PROJECT_TTL_MS = 60_000;

/** Staleness window for waiting_for_permission signals. */
export const PERMISSION_STALE_MS = 5 * 60 * 1000;

/**
 * Minimum time after a PermissionRequest before a same-session PostToolUse can resolve it.
 * Guards against concurrent sub-agents that share the same session_id arriving within this window.
 */
export const PERMISSION_RESOLVE_GAP_MS = 3_000;

/** Debounce window for filesystem watcher update callbacks. */
export const DEBOUNCE_MS = 100;

/** Initial backoff delay for watcher restarts. */
export const BACKOFF_INITIAL_MS = 1_000;

/** Maximum backoff delay for watcher restarts. */
export const BACKOFF_MAX_MS = 30_000;

/** Default polling interval for backend rescans. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Default polling interval for status log changes. */
export const DEFAULT_STATUS_POLL_INTERVAL_MS = 50_000;

/** Number of milliseconds in one hour. */
export const MS_PER_HOUR = 3_600_000;

/** Maximum number of watcher restart attempts before giving up. */
export const MAX_RETRIES = 10;

/** Bytes to keep when trimming the status log after it exceeds MAX_STATUS_LOG_BYTES. */
export const STATUS_LOG_TAIL_BYTES = 8 * 1024;

/** Maximum status log file size in bytes before trimming. */
export const MAX_STATUS_LOG_BYTES = 64 * 1024;

/** Maximum bytes to read on first access for large JSONL files (10 MB). */
export const MAX_FIRST_READ = 10 * 1024 * 1024;
