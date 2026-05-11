import { createBackends } from "../../backends/index.ts";
import type { CcmonConfig } from "../../config.ts";
import { mergeCliOverrides } from "../../config.ts";
import { startServer } from "../../server.ts";

export function runServe(
  config: CcmonConfig,
  port: number | undefined,
  host: string | null,
): void {
  const serveConfig = mergeCliOverrides(config, {
    port,
    host: host ?? undefined,
  });
  const { backends, close } = createBackends(serveConfig);
  const { port: resolvedPort, stop } = startServer({
    port: serveConfig.port,
    hostname: serveConfig.host,
    maxInactivityHours: serveConfig.maxInactivityHours,
    backends,
  });
  process.stdout.write(
    `ccmon server listening on http://${serveConfig.host}:${resolvedPort}\n`,
  );

  process.on("SIGINT", () => {
    stop();
    close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    close();
    process.exit(0);
  });
}
