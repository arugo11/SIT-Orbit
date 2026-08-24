import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("B1 fixture contract", () => {
  it("labels the fixture as local synthetic display without an external API", () => {
    expect(appSource).toContain("B1_OMIYA_EVENT");
    expect(appSource).toContain("合成データ");
    expect(appSource).toContain("B1大宮の合成データです。");
    expect(appSource).toContain("大学の公式記録には接続しません。");
    expect(appSource).toContain("developer-demo-menu");
    expect(appSource).not.toMatch(/\b(fetch|XMLHttpRequest|axios)\b/);
  });
});
