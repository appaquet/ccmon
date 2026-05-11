import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CLAUDE_DIR, scanProjects } from "../../project-utils.ts";
import type { StatusEvent } from "../../session-core.ts";
import {
  mapHookEventToState,
  writeNotificationStatus,
  writeStatusEvent,
  writeStatusTruncate,
  writeSubagentStatus,
} from "../../status-writer.ts";
import { exit } from "../helpers.ts";

export async function runStatus(
  claudeDir?: string,
  input?: string,
): Promise<void> {
  const dir =
    claudeDir ?? process.env.CLAUDE_PROJECTS_DIR ?? DEFAULT_CLAUDE_DIR;

  let raw: string;
  try {
    raw = input ?? (await readStdin());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error reading stdin: ${message}\n`);
    exit(1);
  }

  if (!raw.trim()) {
    process.stderr.write("Error: empty stdin — expected hook JSON payload\n");
    exit(1);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write(
      "Error: invalid JSON on stdin — expected hook JSON payload\n",
    );
    exit(1);
  }

  if (!isHookPayload(payload)) {
    process.stderr.write(
      "Error: stdin JSON missing required fields (session_id, cwd, hook_event_name)\n",
    );
    exit(1);
  }

  const { session_id, cwd, hook_event_name } = payload;

  if (!cwd) {
    process.stderr.write("Error: cwd is empty; cannot resolve project dir\n");
    exit(1);
  }

  const projectDir = await resolveProjectDir(cwd, dir);

  if (hook_event_name === "Notification") {
    try {
      await writeNotificationStatus(
        projectDir,
        payload.message ?? "",
        payload.notification_type ?? "",
        payload.session_id,
        payload.cwd,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error writing notification status: ${message}\n`);
      exit(1);
    }
    process.stdout.write("{}\n");
    process.exit(0);
  }

  if (hook_event_name === "SubagentStop") {
    const agentTranscriptPath = payload.agent_transcript_path;
    if (agentTranscriptPath) {
      const agentStatusPath = agentTranscriptPath.endsWith(".jsonl")
        ? `${agentTranscriptPath.slice(0, -".jsonl".length)}.ccmon-status.json`
        : `${agentTranscriptPath}.ccmon-status.json`;
      try {
        await writeSubagentStatus(agentStatusPath, projectDir);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error writing subagent status: ${message}\n`);
        exit(1);
      }
    }
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const state = mapHookEventToState(hook_event_name);
  if (state === null) {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const event: StatusEvent = {
    event: hook_event_name,
    state,
    timestamp: new Date().toISOString(),
    session_id,
    working_dir: cwd,
  };

  try {
    if (hook_event_name === "SessionEnd") {
      await writeStatusTruncate(projectDir, event);
    } else {
      await writeStatusEvent(projectDir, event);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error writing status: ${message}\n`);
    exit(1);
  }

  process.stdout.write("{}\n");
  process.exit(0);
}

export async function resolveProjectDir(
  cwd: string,
  dir: string,
): Promise<string> {
  const projects = await scanProjects(dir);
  const match = projects.find((p) => p.cwd === cwd);
  if (match) {
    return join(dir, match.projectDir);
  }

  let bestMatch: (typeof projects)[number] | null = null;
  for (const project of projects) {
    if (cwd.startsWith(`${project.cwd}/`)) {
      if (!bestMatch || project.cwd.length > bestMatch.cwd.length) {
        bestMatch = project;
      }
    }
  }
  if (bestMatch) {
    return join(dir, bestMatch.projectDir);
  }

  const encoded = cwd.replace(/\//g, "-");
  const fallbackDir = join(dir, encoded);
  await mkdir(fallbackDir, { recursive: true });
  return fallbackDir;
}

async function readStdin(): Promise<string> {
  return readFileSync(process.stdin.fd, "utf-8");
}

interface HookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  message?: string;
  notification_type?: string;
  agent_id?: string;
  agent_transcript_path?: string;
}

export function isHookPayload(v: unknown): v is HookPayload {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.session_id === "string" &&
    typeof obj.cwd === "string" &&
    typeof obj.hook_event_name === "string"
  );
}
