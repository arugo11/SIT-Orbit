import { describe, expect, it } from "vitest";
import {
  hostAccessRequest,
  requiresLiveScombzStudentRead,
  requiresSitrusPersonalContext,
  requiresVerifiedCampusCapability,
} from "./access-policy";

describe("Chat access policy", () => {
  it("rejects non-http URLs and marks sensitive academic paths", () => {
    expect(hostAccessRequest("javascript:alert(1)")).toBeNull();
    expect(
      hostAccessRequest("https://scombz.shibaura-it.ac.jp/grade/list"),
    ).toMatchObject({
      sensitive: true,
      pattern: "https://scombz.shibaura-it.ac.jp/*",
    });
  });

  it("returns only the validated origin needed by a read-only tool", () => {
    const request = hostAccessRequest("https://example.com/course");
    if (!request) throw new Error("Expected a valid host access request.");
    expect(request).toEqual({
      origin: "https://example.com",
      pattern: "https://example.com/*",
      sensitive: false,
    });
    const sensitive = hostAccessRequest("https://example.com/attendance");
    if (!sensitive)
      throw new Error("Expected a valid sensitive access request.");
    expect(sensitive.sensitive).toBe(true);
  });

  it("fails closed only for campus or already-personal requests", () => {
    expect(requiresVerifiedCampusCapability("文章を推敲して")).toBe(false);
    expect(requiresVerifiedCampusCapability("SCombZの課題を確認して")).toBe(
      true,
    );
    expect(
      requiresVerifiedCampusCapability("続きを教えて", {
        processingScope: "restricted/cast_career",
      }),
    ).toBe(true);
    expect(
      requiresVerifiedCampusCapability("こんにちは", { onScombzPage: true }),
    ).toBe(false);
  });

  it("does not turn public OPAC intent into a live SCombZ read", () => {
    expect(
      requiresLiveScombzStudentRead(
        "この3冊の中で図書館で借りれるものはある?",
        {
          processingScope: "personal/scombz_student",
        },
      ),
    ).toBe(false);
    expect(
      requiresLiveScombzStudentRead("その3冊、芝浦で今借りられる？", {
        processingScope: "personal/scombz_student",
      }),
    ).toBe(false);
    expect(requiresLiveScombzStudentRead("SCombZの履修科目を確認して")).toBe(
      true,
    );
    expect(
      requiresLiveScombzStudentRead("続きを教えて", {
        processingScope: "personal/scombz_student",
      }),
    ).toBe(true);
  });

  it("detects personal SITRUS intent without matching general grade advice", () => {
    expect(requiresSitrusPersonalContext("私の成績を教えて")).toBe(true);
    expect(requiresSitrusPersonalContext("何単位取れている？")).toBe(true);
    expect(requiresSitrusPersonalContext("落とした科目はある？")).toBe(true);
    expect(
      requiresSitrusPersonalContext("この授業の成績評価方法を教えて"),
    ).toBe(false);
    expect(requiresSitrusPersonalContext("成績を上げる一般的な方法")).toBe(
      false,
    );
  });
});
