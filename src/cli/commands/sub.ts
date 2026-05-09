export function runSub(port: number, host: string): void {
  const ws = new WebSocket(`ws://${host}:${port}/ws`);

  ws.onmessage = (event) => {
    const parsed = JSON.parse(event.data.toString());
    const projects = Array.isArray(parsed) ? parsed : parsed.projects;
    process.stdout.write(`${JSON.stringify(projects)}\n`);
  };

  ws.onerror = () => {
    process.stderr.write("ccmon sub: connection error\n");
    process.exit(1);
  };

  ws.onclose = () => {
    process.exit(0);
  };

  process.on("SIGINT", () => {
    ws.close();
    process.exit(0);
  });
}
