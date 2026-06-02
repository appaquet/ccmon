import { describe, expect, test } from "vitest";
import {
  parseMessageData,
  parsePartData,
} from "../../src/parsers/opencode-db.ts";

describe("parsePartData", () => {
  test("returns text part for valid text blob", () => {
    const result = parsePartData(
      JSON.stringify({ type: "text", text: "hello" }),
    );
    expect(result).toEqual({ type: "text", text: "hello" });
  });

  test("returns tool part for valid tool blob", () => {
    const result = parsePartData(
      JSON.stringify({ type: "tool", tool: "Read" }),
    );
    expect(result).toEqual({ type: "tool", tool: "Read" });
  });

  test("returns null for malformed JSON", () => {
    expect(parsePartData("not json {{{")).toBeNull();
  });

  test("returns null for non-object JSON (string)", () => {
    expect(parsePartData('"just a string"')).toBeNull();
  });

  test("returns null for null JSON", () => {
    expect(parsePartData("null")).toBeNull();
  });

  test("returns null for unknown type", () => {
    expect(
      parsePartData(JSON.stringify({ type: "image", url: "http://x" })),
    ).toBeNull();
  });

  test("returns null for text part missing text field", () => {
    expect(parsePartData(JSON.stringify({ type: "text" }))).toBeNull();
  });

  test("returns null for text part with non-string text", () => {
    expect(
      parsePartData(JSON.stringify({ type: "text", text: 42 })),
    ).toBeNull();
  });

  test("returns null for tool part missing tool field", () => {
    expect(parsePartData(JSON.stringify({ type: "tool" }))).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parsePartData("")).toBeNull();
  });

  test("returns null for array JSON", () => {
    expect(parsePartData("[1, 2, 3]")).toBeNull();
  });
});

describe("parseMessageData", () => {
  test("returns message data for valid assistant message", () => {
    const raw = JSON.stringify({
      role: "assistant",
      modelID: "claude-sonnet-4-6",
      tokens: { input: 100, output: 50 },
    });
    const result = parseMessageData(raw);
    expect(result?.role).toBe("assistant");
    expect(result?.modelID).toBe("claude-sonnet-4-6");
    expect(result?.tokens?.input).toBe(100);
  });

  test("returns message data for valid user message without optional fields", () => {
    const result = parseMessageData(JSON.stringify({ role: "user" }));
    expect(result?.role).toBe("user");
    expect(result?.modelID).toBeUndefined();
  });

  test("returns null for malformed JSON", () => {
    expect(parseMessageData("not json")).toBeNull();
  });

  test("returns null when role field is missing", () => {
    expect(parseMessageData(JSON.stringify({ modelID: "claude" }))).toBeNull();
  });

  test("returns null when role is not a string", () => {
    expect(parseMessageData(JSON.stringify({ role: 42 }))).toBeNull();
  });

  test("returns null for null JSON", () => {
    expect(parseMessageData("null")).toBeNull();
  });

  test("returns null for array JSON", () => {
    expect(parseMessageData("[1, 2, 3]")).toBeNull();
  });
});
