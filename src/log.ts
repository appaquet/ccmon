type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function getLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LEVELS) return env as LogLevel;
  return "warn";
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[getLevel()];
}

function emit(
  level: string,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (!shouldLog(level as LogLevel)) return;
  const entry: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg,
  };
  if (fields && Object.keys(fields).length > 0) {
    entry.fields = fields;
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const log = {
  info(msg: string, fields?: Record<string, unknown>): void {
    emit("info", msg, fields);
  },
  warn(msg: string, err?: unknown, fields?: Record<string, unknown>): void {
    const meta = fields ?? {};
    if (err instanceof Error) {
      meta.err = err.message;
    } else if (err !== undefined) {
      meta.err = String(err);
    }
    emit("warn", msg, Object.keys(meta).length > 0 ? meta : undefined);
  },
  error(msg: string, err?: unknown, fields?: Record<string, unknown>): void {
    const meta = fields ?? {};
    if (err instanceof Error) {
      meta.err = err.message;
    } else if (err !== undefined) {
      meta.err = String(err);
    }
    emit("error", msg, Object.keys(meta).length > 0 ? meta : undefined);
  },
};
