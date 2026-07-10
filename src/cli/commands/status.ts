import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_CLAUDE_DIR,
  encodeClaudeProjectPath,
  scanProjects,
} from "../../project-utils.ts";
import type { StatusEvent } from "../../session-core.ts";
import {
  mapHookEventToState,
  writeNotificationStatus,
  writeStatusEvent,
  writeStatusTruncate,
  writeSubagentStatus,
} from "../../status-writer.ts";

export async function runStatus(
  claudeDir?: string,
  input?: string,
): Promise<number> {
  const dir =
    claudeDir ?? process.env.CLAUDE_PROJECTS_DIR ?? DEFAULT_CLAUDE_DIR;
  const payload = readHookPayload(input);
  if (payload === null) return 1;

  const projectDir = await prepareProjectDir(payload.cwd, dir);
  if (projectDir === null) return 1;

  return writeHookStatus(payload, projectDir);
}

function readHookPayload(input?: string): HookPayload | null {
  let raw: string;
  try {
    raw = input ?? readStdin();
  } catch (err) {
    reportError("reading stdin", err);
    return null;
  }

  if (!raw.trim()) {
    process.stderr.write("Error: empty stdin — expected hook JSON payload\n");
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write(
      "Error: invalid JSON on stdin — expected hook JSON payload\n",
    );
    return null;
  }

  if (!isHookPayload(payload)) {
    process.stderr.write(
      "Error: stdin JSON missing required fields (session_id, cwd, hook_event_name)\n",
    );
    return null;
  }

  if (!payload.cwd) {
    process.stderr.write("Error: cwd is empty; cannot resolve project dir\n");
    return null;
  }

  if (!isAbsolute(payload.cwd)) {
    process.stderr.write(
      "Error: cwd must be an absolute path; got a relative path\n",
    );
    return null;
  }

  return payload;
}

async function prepareProjectDir(
  cwd: string,
  claudeDir: string,
): Promise<string | null> {
  try {
    const projectDir = resolveProjectDir(
      cwd,
      claudeDir,
      await scanProjects(claudeDir),
    );
    await mkdir(projectDir, { recursive: true });
    return projectDir;
  } catch (err) {
    reportError("preparing project dir", err);
    return null;
  }
}

async function writeHookStatus(
  payload: HookPayload,
  projectDir: string,
): Promise<number> {
  if (payload.hook_event_name === "Notification") {
    return writeNotification(payload, projectDir);
  }

  if (payload.hook_event_name === "SubagentStop") {
    return writeSubagentStop(payload, projectDir);
  }

  const state = mapHookEventToState(payload.hook_event_name);
  if (state === null) return writeHookResponse();

  const event: StatusEvent = {
    event: payload.hook_event_name,
    state,
    timestamp: new Date().toISOString(),
    session_id: payload.session_id,
    working_dir: payload.cwd,
  };

  try {
    if (payload.hook_event_name === "SessionEnd") {
      await writeStatusTruncate(projectDir, event);
    } else {
      await writeStatusEvent(projectDir, event);
    }
  } catch (err) {
    reportError("writing status", err);
    return 1;
  }

  return writeHookResponse();
}

async function writeNotification(
  payload: HookPayload,
  projectDir: string,
): Promise<number> {
  try {
    await writeNotificationStatus(
      projectDir,
      payload.message ?? "",
      payload.notification_type ?? "",
      payload.session_id,
      payload.cwd,
    );
  } catch (err) {
    reportError("writing notification status", err);
    return 1;
  }
  return writeHookResponse();
}

async function writeSubagentStop(
  payload: HookPayload,
  projectDir: string,
): Promise<number> {
  const agentTranscriptPath = payload.agent_transcript_path;
  if (agentTranscriptPath) {
    const agentStatusPath = agentTranscriptPath.endsWith(".jsonl")
      ? `${agentTranscriptPath.slice(0, -".jsonl".length)}.ccmon-status.json`
      : `${agentTranscriptPath}.ccmon-status.json`;
    try {
      await writeSubagentStatus(agentStatusPath, projectDir);
    } catch (err) {
      reportError("writing subagent status", err);
      return 1;
    }
  }
  return writeHookResponse();
}

function reportError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error ${context}: ${message}\n`);
}

function writeHookResponse(): number {
  process.stdout.write("{}\n");
  return 0;
}

/**
 * Resolves the project directory for a given cwd against the list of known projects.
 * Pure: does not perform any filesystem side effects.
 * Returns the best-matching project dir, or a fallback encoded-path dir under `dir`.
 */
export function resolveProjectDir(
  cwd: string,
  dir: string,
  projects: Array<{ cwd: string; projectDir: string }>,
): string {
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

  const encoded = encodeClaudeProjectPath(cwd);
  return join(dir, encoded);
}

function readStdin(): string {
  return readFileSync(process.stdin.fd, "utf-8");
}

interface HookPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  message?: string;
  notification_type?: string;
  agent_transcript_path?: string;
}

export function isHookPayload(v: unknown): v is HookPayload {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    isNonEmptyString(obj.session_id) &&
    typeof obj.cwd === "string" &&
    isNonEmptyString(obj.hook_event_name) &&
    isOptionalString(obj.message) &&
    isOptionalString(obj.notification_type) &&
    isOptionalString(obj.agent_transcript_path)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
