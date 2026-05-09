/**
 * Type shapes for Claude Code JSONL conversation entries.
 * Discriminated union keyed on the `type` field of each line.
 */

export interface JsonlTextBlock {
  type: "text";
  text: string;
}

export interface JsonlToolUseBlock {
  type: "tool_use";
  name: string;
  id: string;
  input?: Record<string, unknown>;
}

export interface JsonlToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
}

export type JsonlContentBlock =
  | JsonlTextBlock
  | JsonlToolUseBlock
  | JsonlToolResultBlock;

export interface JsonlUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface JsonlMessage {
  content: string | JsonlContentBlock[];
  model?: string;
  usage?: JsonlUsage;
}

export interface JsonlUserEntry {
  type: "user";
  message?: JsonlMessage;
  toolUseResult?: { agentId?: string };
}

export interface JsonlAssistantEntry {
  type: "assistant";
  message?: JsonlMessage;
}

export interface JsonlProgressEntry {
  type: "progress";
  data?: {
    message?: {
      message?: {
        content?: JsonlContentBlock[];
      };
    };
  };
}

export interface JsonlQueueOperationEntry {
  type: "queue-operation";
  operation: string;
  content: string;
}

export interface JsonlCustomTitleEntry {
  type: "custom-title";
  customTitle: string;
}

export type JsonlEntry =
  | JsonlUserEntry
  | JsonlAssistantEntry
  | JsonlProgressEntry
  | JsonlQueueOperationEntry
  | JsonlCustomTitleEntry;

export interface JsonlFirstLine {
  cwd: string;
  sessionId: string;
  slug?: string;
  timestamp?: string;
}
