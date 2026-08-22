import { describe, expect, it } from "vitest";
import {
  isOfficialDiscoveryUrl,
  requestsLibraryTools,
} from "./library-discovery";

describe("library discovery boundary", () => {
  it("advertises library tools only for the current explicit user turn", () => {
    expect(requestsLibraryTools("図書館でロボット工学の本を探して")).toBe(true);
    expect(
      requestsLibraryTools("orbit-library://record/0123456789abcdef の詳細"),
    ).toBe(true);
    expect(
      requestsLibraryTools("ありがとう。今日はここまでで大丈夫です。"),
    ).toBe(false);
    expect(requestsLibraryTools("本当にありがとう")).toBe(false);
    expect(requestsLibraryTools("論文を書き直して")).toBe(false);
  });

  it("rejects SIT Search links carrying query or fragment state", () => {
    expect(
      isOfficialDiscoveryUrl("https://slib.shibaura-it.ac.jp/sublib/"),
    ).toBe(true);
    expect(
      isOfficialDiscoveryUrl(
        "https://slib.shibaura-it.ac.jp/sublib/?session=secret",
      ),
    ).toBe(false);
    expect(
      isOfficialDiscoveryUrl("https://slib.shibaura-it.ac.jp/sublib/#result"),
    ).toBe(false);
  });
});
