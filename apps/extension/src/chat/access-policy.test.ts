import { describe, expect, it } from "vitest";
import { hostAccessRequest, requiresHostConfirmation } from "./access-policy";

describe("Chat access policy", () => {
  it("rejects non-http URLs and marks sensitive academic paths", () => {
    expect(hostAccessRequest("javascript:alert(1)")).toBeNull();
    expect(
      hostAccessRequest("https://scombz.shibaura-it.ac.jp/grade/list"),
    ).toMatchObject({
      sensitive: true,
      pattern: "https://scombz.shibaura-it.ac.jp/*",
    });
  });

  it("keeps Ask mode host-scoped and Full mode read-only", () => {
    const request = hostAccessRequest("https://example.com/course");
    if (!request) throw new Error("Expected a valid host access request.");
    expect(requiresHostConfirmation("ask", request, new Set())).toBe(true);
    expect(
      requiresHostConfirmation("ask", request, new Set([request.origin])),
    ).toBe(false);
    expect(requiresHostConfirmation("full", request, new Set())).toBe(false);
    const sensitive = hostAccessRequest("https://example.com/attendance");
    if (!sensitive)
      throw new Error("Expected a valid sensitive access request.");
    expect(requiresHostConfirmation("full", sensitive, new Set())).toBe(true);
  });
});
