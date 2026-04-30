import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const TMPDIR = Bun.env.TMPDIR || "/tmp";

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(
    TMPDIR,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}
