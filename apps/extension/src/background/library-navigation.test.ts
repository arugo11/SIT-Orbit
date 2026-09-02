import { describe, expect, it } from "vitest";
import {
  classifyLibraryNavigationUrl,
  isCanonicalLibrarySearchRecordRedirect,
  sameNavigationUrl,
  sameSearchNavigationUrl,
} from "./library-navigation";

describe("library navigation policy", () => {
  it("compares ordinary URLs exactly and search params order-independently", () => {
    expect(
      sameNavigationUrl(
        "https://library.shibaura-it.ac.jp/opc/?q=robot",
        "https://library.shibaura-it.ac.jp/opc/?q=robot",
      ),
    ).toBe(true);
    expect(
      sameSearchNavigationUrl(
        "https://library.shibaura-it.ac.jp/opc/xc/search/?b=2&a=1",
        "https://library.shibaura-it.ac.jp/opc/xc/search/?a=1&b=2",
      ),
    ).toBe(true);
  });

  it("accepts only the bounded canonical single-record redirect", () => {
    expect(
      isCanonicalLibrarySearchRecordRedirect(
        "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BB0123?caller=xc-search&hit=1",
      ),
    ).toBe(true);
    expect(
      isCanonicalLibrarySearchRecordRedirect(
        "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BB0123?caller=xc-search&token=secret",
      ),
    ).toBe(false);
  });

  it("classifies only official OPAC routes", () => {
    expect(
      classifyLibraryNavigationUrl(
        "https://library.shibaura-it.ac.jp/opc/xc/search/",
      ),
    ).toBe("search_results");
    expect(
      classifyLibraryNavigationUrl("https://evil.example/opc/xc/search/"),
    ).toBe("unknown");
  });
});
