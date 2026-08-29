import { describe, expect, it } from "vitest";
import {
  isInProgressTestTitle,
  materialBatchBounds,
} from "./scombz-student-reader";

describe("SCombZ test boundary", () => {
  it("fails closed when a test heading has no completion marker", () => {
    expect(isInProgressTestTitle("第2回小テスト")).toBe(true);
    expect(isInProgressTestTitle("確認テスト（設問のみ表示）")).toBe(true);
  });

  it("allows only explicitly completed/result sections", () => {
    expect(isInProgressTestTitle("第1回テスト 結果・講評")).toBe(false);
    expect(isInProgressTestTitle("Final exam completed")).toBe(false);
    expect(isInProgressTestTitle("授業のお知らせ")).toBe(false);
  });
});

describe("SCombZ material pagination", () => {
  it("advances through visible PDF links in batches of twenty", () => {
    expect(materialBatchBounds(45, 0)).toEqual({
      start: 0,
      end: 20,
      truncated: true,
    });
    expect(materialBatchBounds(45, 20)).toEqual({
      start: 20,
      end: 40,
      truncated: true,
    });
    expect(materialBatchBounds(45, 40)).toEqual({
      start: 40,
      end: 45,
      truncated: false,
    });
  });

  it("allows an empty continuation only at the end of the collection", () => {
    expect(materialBatchBounds(20, 20)).toEqual({
      start: 20,
      end: 20,
      truncated: false,
    });
    expect(() => materialBatchBounds(20, 21)).toThrow(
      "material_cursor_invalid",
    );
  });
});
