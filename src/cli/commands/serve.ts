import { createBackends } from "../../backends/index.ts";
import type { CcmonConfig } from "../../config.ts";
import { mergeCliOverrides } from "../../config.ts";
import { startServer } from "../../server.ts";

export function runServe(
  config: CcmonConfig,
  port: number | undefined,
  host: string | null,
): Promise<void> {
  const serveConfig = mergeCliOverrides(config, {
    port,
    host: host ?? undefined,
  });
  const { backends, close } = createBackends(serveConfig);
  const server = startServer({
    port: serveConfig.port,
    hostname: serveConfig.host,
    maxInactivityHours: serveConfig.maxInactivityHours,
    broadcastIntervalMs: serveConfig.broadcastIntervalMs,
    backends,
  });
  return server.ready
    .then(() => {
      process.stdout.write(
        `ccmon server listening on http://${serveConfig.host}:${server.port}\n`,
      );

      let stopped = false;
      const shutdown = () => {
        if (stopped) return;
        stopped = true;
        server.stop();
        close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      server.stop();
      close();
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`ccmon server failed to start: ${message}\n`);
      process.exitCode = 1;
    });
}
