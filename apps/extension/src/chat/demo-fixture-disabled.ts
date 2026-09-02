import type { ChatToolName, ChatToolResultRequest } from "../api/client";

/** Production replacement: deterministic demo data is not bundled. */
export function demoFixtureToolResult(
  _name: ChatToolName,
  _args: Record<string, unknown>,
): ChatToolResultRequest["result"] | null {
  return null;
}
