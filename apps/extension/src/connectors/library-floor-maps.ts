import type { LibraryHoldingSummary } from "../api/client";

const LIBRARY_SITE_ORIGIN = "https://lib.shibaura-it.ac.jp";

export interface LibraryFloorMap {
  image_url: string | null;
  page_url: string;
  label: string;
}

const TOYOSU_FLOOR_MAP: LibraryFloorMap = {
  image_url: `${LIBRARY_SITE_ORIGIN}/files/images/toyosu_room_map_2607.png`,
  page_url: `${LIBRARY_SITE_ORIGIN}/usage/toyosu/`,
  label: "豊洲図書館フロアマップ",
};

const OMIYA_FLOOR_MAPS: Record<string, LibraryFloorMap> = {
  "1": {
    image_url: `${LIBRARY_SITE_ORIGIN}/files/images/oomiya1f.jpg`,
    page_url: `${LIBRARY_SITE_ORIGIN}/usage/oomiya/`,
    label: "大宮図書館1階フロアマップ",
  },
  "2": {
    image_url: `${LIBRARY_SITE_ORIGIN}/files/images/oomiya2f.jpg`,
    page_url: `${LIBRARY_SITE_ORIGIN}/usage/oomiya/second/`,
    label: "大宮図書館2階フロアマップ",
  },
  "3": {
    image_url: `${LIBRARY_SITE_ORIGIN}/files/images/oomiya3f.jpg`,
    page_url: `${LIBRARY_SITE_ORIGIN}/usage/oomiya/third/`,
    label: "大宮図書館3階フロアマップ",
  },
};

const OMIYA_FLOOR_MAP_INDEX: LibraryFloorMap = {
  image_url: null,
  page_url: `${LIBRARY_SITE_ORIGIN}/usage/oomiya/`,
  label: "大宮図書館フロアマップ",
};

/**
 * Resolve only official, public library floor-map pages from OPAC holdings.
 * An unknown floor deliberately returns the index page without guessing an image.
 */
export function libraryFloorMapForHolding(
  holding: Pick<LibraryHoldingSummary, "campus" | "location">,
): LibraryFloorMap | null {
  const location = holding.location ?? "";
  if (holding.campus === "toyosu") return TOYOSU_FLOOR_MAP;
  if (holding.campus !== "omiya") return null;
  const floor = location.match(/(?:^|[^0-9])([123])階/u)?.[1];
  return (floor && OMIYA_FLOOR_MAPS[floor]) || OMIYA_FLOOR_MAP_INDEX;
}

export function uniqueLibraryFloorMaps(
  holdings: readonly Pick<LibraryHoldingSummary, "campus" | "location">[],
): LibraryFloorMap[] {
  const seen = new Set<string>();
  const maps: LibraryFloorMap[] = [];
  for (const holding of holdings) {
    const map = libraryFloorMapForHolding(holding);
    const key = map ? `${map.page_url}#${map.image_url ?? "page"}` : null;
    if (!map || !key || seen.has(key)) continue;
    seen.add(key);
    maps.push(map);
  }
  return maps;
}
