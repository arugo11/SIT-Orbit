import { describe, expect, it } from "vitest";
import { isSitrusGradeUrl } from "./page-context";
import {
  parseSitrusGradeProjection,
  parseSitrusGradeTableProjection,
  type SitrusTextItem,
} from "./sitrus-reader";

const gradeUrl =
  "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/SeisekiTsutiSho.html?N=synthetic";
const summaryUrl =
  "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/ShutokuTaniShukei.html?N=synthetic";

function item(str: string, x: number, y: number): SitrusTextItem {
  return { str, x, y, width: str.length * 8, height: 10 };
}

describe("SITRUS grade projection", () => {
  it("accepts only the visible grade notice URL", () => {
    expect(isSitrusGradeUrl(gradeUrl)).toBe(true);
    expect(isSitrusGradeUrl(summaryUrl)).toBe(true);
    expect(
      isSitrusGradeUrl(
        "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/Seiseki.html",
      ),
    ).toBe(false);
    expect(isSitrusGradeUrl("https://sitrus.sic.shibaura-it.ac.jp/404")).toBe(
      false,
    );
  });

  it("returns only grade rows and cumulative GPA from text items", () => {
    const projection = parseSitrusGradeProjection(
      [
        item("線形代数第１ L0410100 1 2 *A 2 24 1", 20, 500),
        item("微分積分第１ L0410200 1 2 C 1 23 1", 20, 480),
        item("累積GPA 3.1", 600, 200),
      ],
      gradeUrl,
    );
    expect(projection.status).toBe("known");
    expect(projection.grades).toEqual([
      {
        subject: "線形代数第１",
        course_code: "L0410100",
        credits: 2,
        grade: "A",
        year: 2024,
        term: 2,
        term_slot: 1,
        repeated: true,
      },
      {
        subject: "微分積分第１",
        course_code: "L0410200",
        credits: 2,
        grade: "C",
        year: 2023,
        term: 1,
        term_slot: 1,
        repeated: false,
      },
    ]);
    expect(projection.cumulative_gpa).toBe(3.1);
    expect(JSON.stringify(projection)).not.toMatch(
      /pdf|base64|学生番号|oauth|cookie/i,
    );
  });

  it("joins a row whose PDF text items are split across columns", () => {
    const projection = parseSitrusGradeProjection(
      [
        item("情報工学概論 L0410300", 40, 420),
        item("1 2", 430, 420),
        item("B", 620, 420),
        item("1 25 2", 700, 420),
      ],
      gradeUrl,
    );

    expect(projection.grades).toEqual([
      {
        subject: "情報工学概論",
        course_code: "L0410300",
        credits: 2,
        grade: "B",
        year: 2025,
        term: 1,
        term_slot: 2,
        repeated: false,
      },
    ]);
  });

  it("rejects a guessed or unrelated URL without parsing data", () => {
    const projection = parseSitrusGradeProjection(
      [item("秘密の科目 L0410100 1 2 A 1 23 1", 20, 500)],
      "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/NotFound.html",
    );
    expect(projection).toMatchObject({
      status: "unavailable",
      grades: [],
      reason_code: "invalid_grade_url",
    });
  });

  it("projects the visible HTML grade table without inventing course codes", () => {
    const projection = parseSitrusGradeTableProjection(
      [
        { result: "合格", grade: "B", subject: "認知心理学" },
        {
          result: "合格",
          grade: "A",
          subject: "Ｒｅａｄｉｎｇ＆ＷｒｉｔｉｎｇⅠ",
        },
        { result: "合格", grade: "C", subject: "物理学入門" },
        { result: "ヘッダー", grade: "評価", subject: "科目名" },
      ],
      summaryUrl,
    );

    expect(projection).toMatchObject({
      schema_version: "v1",
      status: "known",
      report_label: "取得済み科目",
      cumulative_gpa: null,
      reason_code: null,
      grades: [
        {
          subject: "認知心理学",
          course_code: null,
          credits: null,
          grade: "B",
        },
        {
          subject: "Ｒｅａｄｉｎｇ＆ＷｒｉｔｉｎｇⅠ",
          course_code: null,
          credits: null,
          grade: "A",
        },
        {
          subject: "物理学入門",
          course_code: null,
          credits: null,
          grade: "C",
        },
      ],
    });
    expect(JSON.stringify(projection)).not.toMatch(
      /student|学籍|pdf|base64|oauth|cookie/i,
    );
  });

  it("rejects a table parsed from a non-observed path", () => {
    expect(
      parseSitrusGradeTableProjection(
        [{ result: "合格", grade: "A", subject: "秘密の科目" }],
        "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/NotFound.html",
      ),
    ).toMatchObject({
      status: "unavailable",
      grades: [],
      reason_code: "invalid_grade_url",
    });
  });
});
