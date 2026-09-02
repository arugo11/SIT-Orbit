import { describe, expect, it } from "vitest";
import {
  parseSyllabusDetailHtml,
  parseSyllabusSearchHtml,
} from "./syllabus-search";

describe("official syllabus adapter", () => {
  it("accepts only official HTTPS result links", () => {
    const result = parseSyllabusSearchHtml(
      `<nav><a href="/course/navigation">ナビゲーション</a></nav>
       <dl>
         <dt><a href="/course/1">微積分学</a></dt>
         <dt><a href="https://example.com/no">外部</a></dt>
         <dt><a href="javascript:alert(1)">危険</a></dt>
       </dl>`,
      "微積分",
      2026,
      "工学部",
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        title: "微積分学",
        course_code: null,
        faculty: "工学部",
        url: "https://syllabus.sic.shibaura-it.ac.jp/course/1",
        snippet: null,
      }),
    );
    expect(result.results[0]?.syllabus_ref).toMatch(
      /^orbit-syllabus:\/\/result\/[A-Za-z0-9_-]{16,128}$/u,
    );
    expect(result.results[0]?.citation_uri).toMatch(
      /^orbit-syllabus:\/\/citation\//u,
    );
  });

  it("reads the official panel layout without depending on a page DOM", () => {
    const result = parseSyllabusDetailHtml(`
      <div class="panel panel-default">
        <div class="panel-heading">科目情報</div>
        <div class="panel-body">
          <div id="KamokuCD">L0471800</div>
          <span class="kamoku jpn">&#33258;&#28982;&#35328;&#35486;&#20966;&#29702;</span>
          <table><tr class="teacher"><td class="teacher"><a href="https://resea.shibaura-it.ac.jp/p">&#26441;&#26412;&#12288;&#24505;</a></td></tr></table>
        </div>
      </div>
      <div class="panel panel-default">
        <div class="panel-heading">授業の目的</div>
        <div class="panel-body">自然言語データを扱う基本技術を身につける。</div>
      </div>
      <div class="panel panel-default">
        <div class="panel-heading">授業計画</div>
        <div class="panel-body"><table><tr><th>第1回</th><td>形態素解析</td></tr><tr><th>第2回</th><td>構文解析</td></tr></table></div>
      </div>
      <div class="panel panel-default">
        <div class="panel-heading">評価方法と基準</div>
        <div class="panel-body">レポート課題を評価する。</div>
      </div>
      <div class="panel panel-default">
        <div class="panel-heading">教科書・参考書</div>
        <div class="panel-body">参考書：自然言語処理の基礎<br>補助資料</div>
      </div>
      <div class="panel panel-default">
        <div class="panel-heading">履修登録前の準備</div>
        <div class="panel-body">Pythonプログラミングの知識が必要。</div>
      </div>`);

    expect(result).toMatchObject({
      course_code: "L0471800",
      title: "自然言語処理",
      instructors: ["杉本 徹"],
      objectives: "自然言語データを扱う基本技術を身につける。",
      evaluation: "レポート課題を評価する。",
      prerequisites: "Pythonプログラミングの知識が必要。",
    });
    expect(result.weekly_plan.join(" ")).toContain("形態素解析");
    expect(result.textbooks).toEqual([
      "参考書：自然言語処理の基礎",
      "補助資料",
    ]);
  });
});
