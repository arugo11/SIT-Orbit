import { describe, expect, it } from "vitest";
import { classifyPageKind, isScombzUrl, mapPageContext } from "./page-context";

describe("page context mapping", () => {
  it("keeps only the title and URL while classifying a ScombZ route", () => {
    expect(
      mapPageContext({
        title: "  課題一覧  ",
        url: "https://scombz.shibaura-it.ac.jp/course/calculus/assignments",
      }),
    ).toEqual({
      title: "課題一覧",
      url: "https://scombz.shibaura-it.ac.jp/course/calculus/assignments",
      kind: "scombz",
    });
  });

  it("classifies the B1 fixture-style route deterministically", () => {
    expect(
      mapPageContext({
        title: "ScombZ",
        url: "https://scombz.shibaura-it.ac.jp/portal/home",
      }).kind,
    ).toBe("scombz");
  });

  it("does not treat another origin as ScombZ context", () => {
    expect(isScombzUrl("https://example.com/course/assignments")).toBe(false);
    expect(classifyPageKind("https://example.com/course/assignments")).toBe(
      "other",
    );
  });

  it("uses a stable title for a blank document title", () => {
    expect(
      mapPageContext({
        title: "   ",
        url: "https://scombz.shibaura-it.ac.jp/unknown",
      }).title,
    ).toBe("無題のページ");
  });
});
