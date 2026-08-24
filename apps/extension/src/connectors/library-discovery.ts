import type {
  LibraryCatalogBrowseResult,
  LibraryCatalogSearchResult,
  LibraryDiscoverySearchResult,
  LibraryItemReadResult,
} from "../api/client";

export const LIBRARY_OPAC_ORIGIN = "https://library.shibaura-it.ac.jp";
export const LIBRARY_OPAC_ENTRY_URL = `${LIBRARY_OPAC_ORIGIN}/opc/`;
export const LIBRARY_OPAC_PERMISSION_PATTERN = `${LIBRARY_OPAC_ORIGIN}/*`;
export const LIBRARY_SIT_SEARCH_ORIGIN = "https://slib.shibaura-it.ac.jp";
export const LIBRARY_SIT_SEARCH_ENTRY_URL = `${LIBRARY_SIT_SEARCH_ORIGIN}/sublib/`;
export const LIBRARY_SIT_SEARCH_PERMISSION_PATTERN = `${LIBRARY_SIT_SEARCH_ORIGIN}/*`;
export const LIBRARY_NEW_BOOKS_URL = `${LIBRARY_OPAC_ORIGIN}/cgi-bin/nbk/nbk_seek.cgi?ulang=jpn`;
export const LIBRARY_LOAN_RANKING_URL = `${LIBRARY_OPAC_ORIGIN}/cgi-bin/loan_best10/loan_best10.cgi?ulang=jpn`;
export const LIBRARY_RECORD_PATH_PREFIX = "/opc/recordID/catalog.bib/";
export const LIBRARY_RESOURCE_REF_PREFIX = "orbit-library://record/";

export type LibraryCampus = "toyosu" | "omiya" | "any";
export type LibraryFormat = "book" | "journal" | "ebook" | "any";
export type LibraryBrowseKind = "new_books" | "loan_ranking";

export interface LibraryCatalogSearchArguments {
  query: string;
  author?: string | null;
  subject?: string | null;
  isbn?: string | null;
  pub_year?: number | null;
  campus?: LibraryCampus;
  format?: LibraryFormat;
  limit?: number;
}

export interface LibraryCatalogBrowseArguments {
  kind: LibraryBrowseKind;
  campus?: LibraryCampus;
  limit?: number;
}

export interface LibraryDiscoverySearchArguments {
  query: string;
  limit?: number;
}

export function isLibraryResourceRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u.test(value)
  );
}

/**
 * Derive a stable opaque reference from the public OPAC record identifier.
 * The original identifier is retained only in the service worker's
 * short-lived in-memory map; it is never sent as a tool argument or result.
 */
export function createLibraryResourceRef(recordId: string): string {
  const normalized = recordId.trim();
  if (!normalized || !/^[^/?#\s]{1,200}$/u.test(normalized)) {
    throw new TypeError("The OPAC record identifier is invalid.");
  }
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + 0x9e3779b9;
    second = Math.imul(second, 0x01000193);
  }
  const opaque = `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
  return `${LIBRARY_RESOURCE_REF_PREFIX}${opaque}`;
}

export function libraryRecordUrl(recordId: string): string {
  const normalized = recordId.trim();
  if (!normalized || !/^[^/?#\s]{1,200}$/u.test(normalized)) {
    throw new TypeError("The OPAC record identifier is invalid.");
  }
  return `${LIBRARY_OPAC_ORIGIN}${LIBRARY_RECORD_PATH_PREFIX}${encodeURIComponent(
    normalized,
  )}`;
}

export function isOfficialLibraryRecordUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === LIBRARY_OPAC_ORIGIN &&
      url.protocol === "https:" &&
      url.pathname.startsWith(LIBRARY_RECORD_PATH_PREFIX) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function isOfficialDiscoveryUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ((url.origin === LIBRARY_SIT_SEARCH_ORIGIN &&
        url.pathname.startsWith("/sublib/") &&
        url.search === "" &&
        url.hash === "") ||
        (url.origin === LIBRARY_OPAC_ORIGIN &&
          url.pathname.startsWith(LIBRARY_RECORD_PATH_PREFIX) &&
          url.pathname.slice(LIBRARY_RECORD_PATH_PREFIX.length).length > 0 &&
          url.search === "" &&
          url.hash === "")) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export type LibraryToolResult =
  | LibraryCatalogSearchResult
  | LibraryItemReadResult
  | LibraryCatalogBrowseResult
  | LibraryDiscoverySearchResult;

/**
 * Public library reads are available on every Chat turn. Keep this helper as
 * a compatibility surface for callers that used the old intent heuristic;
 * the latest-message wording must not gate catalog access.
 */
export function requestsLibraryTools(_message: string): boolean {
  return true;
}
