import type {
  JsonlAssistantEntry,
  JsonlContentBlock,
  JsonlCustomTitleEntry,
  JsonlEntry,
  JsonlProgressEntry,
  JsonlQueueOperationEntry,
  JsonlTextBlock,
  JsonlToolUseBlock,
  JsonlUserEntry,
} from "./parsers/claude-jsonl";
import type { SessionEnrichment, TaskInfo } from "./types";

export type { SessionEnrichment, TaskInfo };

/**
 * Carries enrichment extracted from a JSONL tail scan, plus the per-session
 * agentDescriptions map needed to annotate sub-agents without a separate parse pass.
 */
export interface SessionTailInfo extends SessionEnrichment {
  agentDescriptions: Map<string, string>;
}

import { MAX_FIRST_READ } from "./timing.js";

// Keyed by jsonlPath; avoids re-reading the tail unless the file changed.
export interface SessionTailCache {
  mtime: number;
  fileSize: number;
  data: SessionTailInfo;
}

/**
 * Extracts a slash command string from a user message content string.
 */
export function extractCommand(content: string): string | null {
  const nameMatch = content.match(/<command-name>([^<]+)<\/command-name>/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  const argsMatch = content.match(/<command-args>([^<]*)<\/command-args>/);
  const args = argsMatch ? argsMatch[1].trim() : "";
  return args ? `${name} ${args}` : name;
}

/**
 * Determines the byte offset and base data for a readSessionTail read.
 * Returns startOffset === -1 to signal a cache hit (no re-read needed).
 */
export function computeReadRange(
  cached: SessionTailCache | undefined,
  mtimeMs: number,
  size: number,
): { startOffset: number; baseData: SessionTailInfo; isDelta: boolean } {
  if (
    cached !== undefined &&
    cached.mtime === mtimeMs &&
    cached.fileSize === size
  ) {
    return { startOffset: -1, baseData: cached.data, isDelta: false };
  } else if (cached !== undefined && size > cached.fileSize) {
    return {
      startOffset: cached.fileSize,
      baseData: {
        ...cached.data,
        agentDescriptions: new Map(cached.data.agentDescriptions),
      },
      isDelta: true,
    };
  } else {
    return {
      startOffset: Math.max(0, size - MAX_FIRST_READ),
      baseData: { agentDescriptions: new Map() },
      isDelta: false,
    };
  }
}

/**
 * Reversed-scan pass over JSONL lines (newest-to-oldest).
 * Extracts the most-recent user activity, assistant activity, model, token counts,
 * and agent descriptions. Uses TodoWrite as a fallback when no TaskCreate tasks exist.
 */
export function scanEnrichment(
  lines: string[],
  scannedTasks: Map<string, TaskInfo> | null,
  baseData: SessionTailInfo,
): SessionTailInfo {
  const reversed = lines.slice().reverse();
  const ctx: ScanContext = {
    result: { agentDescriptions: new Map() },
    taskToolDescriptions: new Map(),
    pendingToolResults: new Map(),
    foundUserActivity: false,
    foundAssistantActivity: false,
    foundModel: false,
    foundSessionName: false,
    foundTasks:
      (scannedTasks !== null && scannedTasks.size > 0) ||
      baseData.tasks !== undefined,
    scanInputTokens: undefined,
    scanOutputTokens: 0,
  };

  for (const line of reversed) {
    let entry: JsonlEntry;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as JsonlEntry;
    } catch {
      continue;
    }

    switch (entry.type) {
      case "user":
        handleUserEntry(entry, ctx);
        break;
      case "assistant":
        handleAssistantEntry(entry, ctx);
        break;
      case "progress":
        handleProgressEntry(entry, ctx);
        break;
      case "queue-operation":
        handleQueueOperationEntry(entry, ctx);
        break;
      case "custom-title":
        handleCustomTitleEntry(entry, ctx);
        break;
    }
  }

  for (const [toolUseId, agentId] of ctx.pendingToolResults) {
    const description = ctx.taskToolDescriptions.get(toolUseId);
    if (description !== undefined) {
      ctx.result.agentDescriptions.set(agentId, description);
    }
  }

  if (ctx.scanInputTokens !== undefined && ctx.scanInputTokens > 0)
    ctx.result.inputTokens = ctx.scanInputTokens;
  if (ctx.scanOutputTokens > 0) ctx.result.outputTokens = ctx.scanOutputTokens;
  return ctx.result;
}

/**
 * Merges a fresh scan result with the base (cached) data into a final SessionTailInfo.
 */
export function mergeEnrichment(
  scannedTasks: Map<string, TaskInfo> | null,
  scanResult: SessionTailInfo,
  baseData: SessionTailInfo,
): SessionTailInfo {
  let mergedTasks: TaskInfo[] | undefined;
  let mergedTasksDone: number | undefined;
  let mergedTasksTotal: number | undefined;

  if (scannedTasks !== null || baseData.tasks !== undefined) {
    const taskMap = new Map<string, TaskInfo>();
    if (baseData.tasks) {
      for (const t of baseData.tasks) taskMap.set(t.id, { ...t });
    }
    if (scannedTasks !== null) {
      for (const [id, t] of scannedTasks) taskMap.set(id, { ...t });
    }
    const taskList = [...taskMap.values()].sort((a, b) => {
      const na = parseInt(a.id, 10);
      const nb = parseInt(b.id, 10);
      return na - nb;
    });
    mergedTasks = taskList;
    const nonDeleted = taskList.filter((t) => t.status !== "deleted");
    mergedTasksTotal = nonDeleted.length;
    mergedTasksDone = nonDeleted.filter((t) => t.status === "completed").length;
  } else if (scanResult.tasksTotal !== undefined) {
    mergedTasksDone = scanResult.tasksDone;
    mergedTasksTotal = scanResult.tasksTotal;
  } else {
    mergedTasksDone = baseData.tasksDone;
    mergedTasksTotal = baseData.tasksTotal;
    mergedTasks = baseData.tasks;
  }

  // Input tokens: cache_read grows monotonically across assistant entries,
  // so last-wins is correct (summing would double-count).
  const mergedInputTokens = scanResult.inputTokens ?? baseData.inputTokens;
  // Output tokens: each assistant entry reports per-call delta,
  // so additive merge across entries is correct.
  const mergedOutputTokens =
    (baseData.outputTokens ?? 0) + (scanResult.outputTokens ?? 0);

  const mergedDescriptions = baseData.agentDescriptions;
  for (const [id, desc] of scanResult.agentDescriptions) {
    mergedDescriptions.set(id, desc);
  }

  const merged: SessionTailInfo = {
    agentDescriptions: mergedDescriptions,
  };
  const latestUserActivity =
    scanResult.latestUserActivity ?? baseData.latestUserActivity;
  if (latestUserActivity !== undefined)
    merged.latestUserActivity = latestUserActivity;
  const latestAssistantActivity =
    scanResult.latestAssistantActivity ?? baseData.latestAssistantActivity;
  if (latestAssistantActivity !== undefined)
    merged.latestAssistantActivity = latestAssistantActivity;
  const model = scanResult.model ?? baseData.model;
  if (model !== undefined) merged.model = model;
  const sessionName = scanResult.sessionName ?? baseData.sessionName;
  if (sessionName !== undefined) merged.sessionName = sessionName;
  if (mergedTasks !== undefined) merged.tasks = mergedTasks;
  if (mergedTasksDone !== undefined) merged.tasksDone = mergedTasksDone;
  if (mergedTasksTotal !== undefined) merged.tasksTotal = mergedTasksTotal;
  const mergedInputTokensFinal =
    mergedInputTokens !== undefined && mergedInputTokens > 0
      ? mergedInputTokens
      : undefined;
  if (mergedInputTokensFinal !== undefined)
    merged.inputTokens = mergedInputTokensFinal;
  const mergedOutputTokensFinal =
    mergedOutputTokens > 0 ? mergedOutputTokens : undefined;
  if (mergedOutputTokensFinal !== undefined)
    merged.outputTokens = mergedOutputTokensFinal;
  return merged;
}

/**
 * Forward-scans JSONL lines for TaskCreate/TaskUpdate tool_use blocks.
 */
export function scanTaskCreateUpdate(
  lines: string[],
  baseTasks?: TaskInfo[],
): Map<string, TaskInfo> | null {
  const pendingCreates = new Map<
    string,
    { subject: string; activeForm?: string }
  >();
  const tasks = new Map<string, TaskInfo>(
    baseTasks?.map((t) => [t.id, { ...t }]),
  );

  for (const line of lines) {
    let entry: JsonlEntry;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as JsonlEntry;
    } catch {
      continue;
    }

    if (
      entry.type === "assistant" &&
      entry.message &&
      Array.isArray(entry.message.content)
    ) {
      for (const block of entry.message.content) {
        if (block.type !== "tool_use") continue;
        if (typeof block.id !== "string") continue;
        const input = block.input;
        if (!input) continue;

        if (block.name === "TaskCreate" && typeof input.subject === "string") {
          pendingCreates.set(block.id, {
            subject: input.subject,
            activeForm:
              typeof input.activeForm === "string"
                ? input.activeForm
                : undefined,
          });
        }

        if (block.name === "TaskUpdate" && typeof input.taskId === "string") {
          const existing = tasks.get(input.taskId);
          if (existing) {
            if (typeof input.status === "string")
              existing.status = input.status;
            if (typeof input.subject === "string")
              existing.subject = input.subject;
            existing.activeForm =
              typeof input.activeForm === "string"
                ? input.activeForm
                : undefined;
          }
        }
      }
    }

    if (
      entry.type === "user" &&
      entry.message &&
      Array.isArray(entry.message.content)
    ) {
      for (const block of entry.message.content) {
        if (block.type !== "tool_result") continue;
        if (typeof block.tool_use_id !== "string") continue;

        const pending = pendingCreates.get(block.tool_use_id);
        if (!pending) continue;

        let taskId: string | undefined;
        const content = block.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? (content as unknown[])
                  .filter(
                    (c): c is { type: string; text: string } =>
                      typeof c === "object" &&
                      c !== null &&
                      (c as Record<string, unknown>).type === "text",
                  )
                  .map((c) => c.text)
                  .join("")
              : "";
        const match = text.match(/Task #(\d+)/i);
        if (match) taskId = match[1];

        if (taskId) {
          tasks.set(taskId, {
            id: taskId,
            subject: pending.subject,
            status: "pending",
            activeForm: pending.activeForm,
          });
          pendingCreates.delete(block.tool_use_id);
        }
      }
    }
  }

  return tasks.size > 0 ? tasks : null;
}

export function scanTodoWrite(
  contentBlocks: JsonlContentBlock[],
): { tasksDone: number; tasksTotal: number } | null {
  const todoWrite = contentBlocks.find(
    (item): item is JsonlToolUseBlock & { name: "TodoWrite" } =>
      item.type === "tool_use" && item.name === "TodoWrite",
  );
  if (todoWrite === undefined) return null;
  const input = todoWrite.input;
  if (input === undefined || !Array.isArray(input.todos)) return null;
  const todos = input.todos as Array<{ status: string }>;
  return {
    tasksTotal: todos.length,
    tasksDone: todos.filter((t) => t.status === "completed").length,
  };
}

export function isTextBlock(b: unknown): b is JsonlTextBlock {
  return (
    typeof b === "object" &&
    b !== null &&
    (b as Record<string, unknown>).type === "text" &&
    typeof (b as Record<string, unknown>).text === "string"
  );
}

export function isToolUseBlock(b: unknown): b is JsonlToolUseBlock {
  return (
    typeof b === "object" &&
    b !== null &&
    (b as Record<string, unknown>).type === "tool_use" &&
    typeof (b as Record<string, unknown>).name === "string"
  );
}

interface ScanContext {
  result: SessionTailInfo;
  taskToolDescriptions: Map<string, string>;
  pendingToolResults: Map<string, string>;
  foundUserActivity: boolean;
  foundAssistantActivity: boolean;
  foundModel: boolean;
  foundSessionName: boolean;
  foundTasks: boolean;
  scanInputTokens: number | undefined;
  scanOutputTokens: number;
}

function handleUserEntry(entry: JsonlUserEntry, ctx: ScanContext): void {
  const message = entry.message;

  if (message && Array.isArray(message.content)) {
    const toolUseResult = entry.toolUseResult;
    const agentId =
      typeof toolUseResult?.agentId === "string"
        ? toolUseResult.agentId
        : undefined;
    if (agentId !== undefined) {
      for (const block of message.content) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          ctx.pendingToolResults.set(block.tool_use_id, agentId);
        }
      }
    }
  }

  if (!message || ctx.foundUserActivity) return;
  const content = message.content;
  if (typeof content === "string") {
    const isXml = content.startsWith("<");
    const cmd = isXml ? extractCommand(content) : null;
    if (cmd !== null) {
      ctx.result.latestUserActivity = { text: cmd, isCommand: true };
      ctx.foundUserActivity = true;
    } else if (!isXml) {
      ctx.result.latestUserActivity = {
        text: content.slice(0, 200),
        isCommand: false,
      };
      ctx.foundUserActivity = true;
    }
  }
}

function handleAssistantEntry(
  entry: JsonlAssistantEntry,
  ctx: ScanContext,
): void {
  const message = entry.message;
  if (!message) return;

  if (!ctx.foundModel && typeof message.model === "string") {
    ctx.result.model = message.model;
    ctx.foundModel = true;
  }

  const usage = message.usage;
  if (usage !== undefined) {
    const input =
      typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const cacheCreate =
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0;
    const cacheRead =
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0;
    if (ctx.scanInputTokens === undefined)
      ctx.scanInputTokens = input + cacheCreate + cacheRead;
    if (typeof usage.output_tokens === "number")
      ctx.scanOutputTokens += usage.output_tokens;
  }

  if (Array.isArray(message.content)) {
    const contentBlocks = message.content;

    if (!ctx.foundTasks) {
      const todoWriteResult = scanTodoWrite(contentBlocks);
      if (todoWriteResult !== null) {
        ctx.result.tasksDone = todoWriteResult.tasksDone;
        ctx.result.tasksTotal = todoWriteResult.tasksTotal;
        ctx.foundTasks = true;
      }
    }

    if (!ctx.foundAssistantActivity) {
      const textBlock = contentBlocks.find(isTextBlock);
      const toolUse = contentBlocks.find(isToolUseBlock);
      if (textBlock !== undefined || toolUse !== undefined) {
        ctx.result.latestAssistantActivity = {
          text: textBlock ? textBlock.text.slice(0, 200) : undefined,
          tool: toolUse ? toolUse.name : undefined,
        };
        ctx.foundAssistantActivity = true;
      }
    }

    for (const block of contentBlocks) {
      if (
        block.type === "tool_use" &&
        block.name === "Task" &&
        typeof block.id === "string"
      ) {
        const input = block.input;
        if (typeof input?.description === "string") {
          ctx.taskToolDescriptions.set(block.id, input.description);
        }
      }
    }
  }
}

function handleProgressEntry(
  entry: JsonlProgressEntry,
  ctx: ScanContext,
): void {
  if (ctx.foundTasks) return;
  const data = entry.data;
  const outerMsg = data?.message;
  const innerMsg = outerMsg?.message;
  const content = innerMsg?.content;
  if (Array.isArray(content)) {
    const todoWriteResult = scanTodoWrite(content);
    if (todoWriteResult !== null) {
      ctx.result.tasksDone = todoWriteResult.tasksDone;
      ctx.result.tasksTotal = todoWriteResult.tasksTotal;
      ctx.foundTasks = true;
    }
  }
}

function handleQueueOperationEntry(
  entry: JsonlQueueOperationEntry,
  ctx: ScanContext,
): void {
  const operation = entry.operation;
  if (operation === "enqueue" && typeof entry.content === "string") {
    try {
      const parsed = JSON.parse(entry.content) as Record<string, unknown>;
      if (
        typeof parsed.task_id === "string" &&
        typeof parsed.description === "string"
      ) {
        ctx.result.agentDescriptions.set(parsed.task_id, parsed.description);
      }
    } catch {
      // malformed content — skip
    }
  }
}

function handleCustomTitleEntry(
  entry: JsonlCustomTitleEntry,
  ctx: ScanContext,
): void {
  if (ctx.foundSessionName) return;
  if (typeof entry.customTitle === "string") {
    ctx.result.sessionName = entry.customTitle;
    ctx.foundSessionName = true;
  }
}
