import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("B1 fixture contract", () => {
  it("labels the fixture as local synthetic display without an external API", () => {
    expect(appSource).toContain('campus: "B1 大宮"');
    expect(appSource).toContain("合成データ");
    expect(appSource).toContain("これはローカルの静的表示です。");
    expect(appSource).toContain("APIや大学の公式記録には接続していません。");
    expect(appSource).toContain("外部サービスへの書き込みは行いません。");
    expect(appSource).not.toMatch(/\b(fetch|XMLHttpRequest|axios)\b/);
  });
});
