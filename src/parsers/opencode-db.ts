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
