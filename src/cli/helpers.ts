export function exit(code: number): never {
  process.exit(code);
}

export function parseStringFlag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

export function parseNumberFlag(
  argv: string[],
  name: string,
): number | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Parses a --port flag, returning undefined if absent or not a valid port (integer 1..65535). */
export function parsePortFlag(
  argv: string[],
  name: string,
): number | undefined {
  const raw = parseNumberFlag(argv, name);
  if (raw === undefined) return undefined;
  return isValidPort(raw) ? raw : undefined;
}

/** Returns true if n is an integer in the range 1..65535. */
export function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}
