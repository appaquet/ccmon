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
  const value = parseFloat(argv[idx + 1] ?? "");
  return Number.isNaN(value) ? undefined : value;
}
