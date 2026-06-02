/**
 * Type shapes for OpenCode SQLite data blobs (message.data, part.data).
 */

export interface OpencodeMessageData {
  role: string;
  modelID?: string;
  tokens?: OpencodeTokens;
}

export interface OpencodeTokens {
  input?: number;
  output?: number;
  cache?: {
    read?: number;
  };
}

export interface OpencodeTextPart {
  type: "text";
  text: string;
}

export interface OpencodeToolPart {
  type: "tool";
  tool: string;
}

export type OpencodePartData = OpencodeTextPart | OpencodeToolPart;

/**
 * Parses and validates a message.data JSON blob from the OpenCode SQLite store.
 * Returns null when the blob is absent, malformed, or missing the required `role` field.
 */
export function parseMessageData(raw: string): OpencodeMessageData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.role !== "string") return null;
  return parsed as OpencodeMessageData;
}

/**
 * Parses and validates a part.data JSON blob from the OpenCode SQLite store.
 * Returns null when the blob is absent, malformed, or not a recognised part type.
 */
export function parsePartData(raw: string): OpencodePartData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") {
    return { type: "text", text: obj.text };
  }
  if (obj.type === "tool" && typeof obj.tool === "string") {
    return { type: "tool", tool: obj.tool };
  }
  return null;
}
