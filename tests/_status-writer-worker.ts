/**
 * Minimal subprocess entry point for the concurrent-writers test.
 * Usage: node --experimental-strip-types tests/_status-writer-worker.ts <projectDir> <eventJson>
 */

import type { StatusEvent } from "../src/session-core.ts";
import { writeStatusEvent } from "../src/status-writer.ts";

const [projectDir, eventJson] = process.argv.slice(2);
if (!projectDir || !eventJson) {
  process.stderr.write("usage: worker <projectDir> <eventJson>\n");
  process.exit(1);
}

const event = JSON.parse(eventJson) as StatusEvent;
await writeStatusEvent(projectDir, event);
