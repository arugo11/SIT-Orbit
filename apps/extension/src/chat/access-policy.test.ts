import { describe, expect, it } from "vitest";
import { hostAccessRequest } from "./access-policy";

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

  it("returns only the validated origin needed by a read-only tool", () => {
    const request = hostAccessRequest("https://example.com/course");
    if (!request) throw new Error("Expected a valid host access request.");
    expect(request).toEqual({
      origin: "https://example.com",
      pattern: "https://example.com/*",
      sensitive: false,
    });
    const sensitive = hostAccessRequest("https://example.com/attendance");
    if (!sensitive)
      throw new Error("Expected a valid sensitive access request.");
    expect(sensitive.sensitive).toBe(true);
  });
});
