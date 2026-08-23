import { describe, expect, it } from "vitest";
import {
  libraryFloorMapForHolding,
  uniqueLibraryFloorMaps,
} from "./library-floor-maps";

describe("library floor maps", () => {
  it("maps Toyosu holdings to the official public floor map image", () => {
    expect(
      libraryFloorMapForHolding({
        campus: "toyosu",
        location: "豊洲図書館 豊洲図書館",
      }),
    ).toEqual({
      image_url:
        "https://lib.shibaura-it.ac.jp/files/images/toyosu_room_map_2607.png",
      page_url: "https://lib.shibaura-it.ac.jp/usage/toyosu/",
      label: "豊洲図書館フロアマップ",
    });
  });

  it.each([
    ["1階雑誌・参考図書", "oomiya1f.jpg", "usage/oomiya/"],
    ["2階閲覧席", "oomiya2f.jpg", "usage/oomiya/second/"],
    ["3階書架(C)機械・電気", "oomiya3f.jpg", "usage/oomiya/third/"],
  ])("maps Omiya %s to its official floor map", (location, image, page) => {
    const result = libraryFloorMapForHolding({ campus: "omiya", location });
    expect(result?.image_url).toBe(
      `https://lib.shibaura-it.ac.jp/files/images/${image}`,
    );
    expect(result?.page_url).toBe(`https://lib.shibaura-it.ac.jp/${page}`);
  });

  it("does not guess an image when the Omiya floor is unknown", () => {
    expect(
      libraryFloorMapForHolding({
        campus: "omiya",
        location: "大宮図書館 書架",
      }),
    ).toEqual({
      image_url: null,
      page_url: "https://lib.shibaura-it.ac.jp/usage/oomiya/",
      label: "大宮図書館フロアマップ",
    });
  });

  it("does not create a map for an unknown campus", () => {
    expect(
      libraryFloorMapForHolding({ campus: "unknown", location: "書架" }),
    ).toBeNull();
  });

  it("deduplicates multiple holdings on the same floor", () => {
    expect(
      uniqueLibraryFloorMaps([
        { campus: "omiya", location: "大宮図書館 3階書架(A)" },
        { campus: "omiya", location: "大宮図書館 3階書架(C)" },
        { campus: "omiya", location: "大宮図書館 書架" },
        { campus: "toyosu", location: "豊洲図書館 専門書架" },
      ]),
    ).toHaveLength(3);
  });
});
