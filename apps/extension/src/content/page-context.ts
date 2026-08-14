export const SCOMBZ_ORIGIN = "https://scombz.shibaura-it.ac.jp";

export type PageKind = "scombz" | "other";

export interface PageContext {
  title: string;
  url: string;
  kind: PageKind;
}

export interface PageSnapshot {
  title: string;
  url: string;
}

export function isScombzUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.hostname === "scombz.shibaura-it.ac.jp"
    );
  } catch {
    return false;
  }
}

export function classifyPageKind(value: string | undefined): PageKind {
  return isScombzUrl(value) ? "scombz" : "other";
}

export function mapPageContext(snapshot: PageSnapshot): PageContext {
  const title = snapshot.title.trim();
  const url = snapshot.url.trim();

  return {
    title: title || "無題のページ",
    url,
    kind: classifyPageKind(url),
  };
}
