import { getProjectState } from './sessions';

const subcommand = process.argv[2];

if (subcommand === 'dump') {
  try {
    const state = await getProjectState();
    console.log(JSON.stringify(state, null, 2));
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write('Usage: ccmon <subcommand>\n\nSubcommands:\n  dump    Print current Claude Code project state as JSON\n');
  process.exit(1);
}
