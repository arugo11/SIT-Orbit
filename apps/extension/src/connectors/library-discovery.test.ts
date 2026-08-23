import { describe, expect, it } from "vitest";
import {
  isOfficialDiscoveryUrl,
  requestsLibraryTools,
} from "./library-discovery";

describe("library discovery boundary", () => {
  it("keeps public library tools available independent of wording", () => {
    expect(requestsLibraryTools("図書館で本を探して")).toBe(true);
    expect(requestsLibraryTools("どこに配架されてる？")).toBe(true);
    expect(
      requestsLibraryTools("ありがとう。今日はここまでで大丈夫です。"),
    ).toBe(true);
    expect(requestsLibraryTools("本当にありがとう")).toBe(true);
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
