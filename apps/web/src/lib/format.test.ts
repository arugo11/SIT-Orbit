import { describe, expect, it } from "vitest";

import { formatActionDuration } from "./format";

describe("formatActionDuration", () => {
  it("formats the mission duration", () => {
    expect(formatActionDuration(12)).toBe("12 MIN");
  });
});
