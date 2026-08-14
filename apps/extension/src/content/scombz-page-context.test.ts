import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { parseScombzPageContext } from "./page-context";

const SCOMBZ_URL = "https://scombz.shibaura-it.ac.jp";

function fixtureDocument(name: string): Document {
  const html = readFileSync(
    new URL(`./fixtures/${name}.html`, import.meta.url),
    "utf8",
  );
  return parseHTML(html).document;
}

function documentFromHtml(html: string): Document {
  return parseHTML(html).document;
}

describe("ScombZ page context extraction", () => {
  it("extracts home data deterministically and excludes the footer", () => {
    const snapshot = {
      title: "  ScombZ ホーム  ",
      url: `${SCOMBZ_URL}/portal/home`,
    };
    const first = parseScombzPageContext(snapshot, fixtureDocument("home"));
    const second = parseScombzPageContext(snapshot, fixtureDocument("home"));

    expect(first).toEqual(second);
    expect(first).toEqual({
      title: "ScombZ ホーム",
      url: `${SCOMBZ_URL}/portal/home`,
      kind: "scombz",
      scombz: {
        route: "home",
        tasks: [],
        announcements: [
          {
            title: "合成のお知らせ",
            url: `${SCOMBZ_URL}/portal/notice/synthetic`,
          },
        ],
        calendar: {
          googleCalendarUrl:
            "https://calendar.google.com/calendar/r/eventedit?text=synthetic",
          icsUrl: `${SCOMBZ_URL}/portal/calendar/synthetic.ics`,
        },
        currentCourse: null,
        relatedLinks: [
          {
            label: "合成図書館",
            url: `${SCOMBZ_URL}/library/synthetic`,
          },
          {
            label: "ヘルプ",
            url: `${SCOMBZ_URL}/portal/home#help`,
          },
        ],
      },
    });
  });

  it("uses the related-link fallback when the primary block is absent", () => {
    const context = parseScombzPageContext(
      { title: "ScombZ", url: `${SCOMBZ_URL}/portal/home` },
      documentFromHtml(`
        <section id="top_notice">
          <a class="portal-subblock-link-main-a" href="/notice/synthetic">
            合成のお知らせ
          </a>
        </section>
      `),
    );

    expect(context.scombz?.relatedLinks).toEqual([
      {
        label: "合成のお知らせ",
        url: `${SCOMBZ_URL}/notice/synthetic`,
      },
    ]);
  });

  it("extracts announcement-list titles without inventing row URLs", () => {
    const context = parseScombzPageContext(
      {
        title: "お知らせ一覧",
        url: `${SCOMBZ_URL}/portal/home/information/list`,
      },
      documentFromHtml(`
        <main id="informationDataList">
          <div class="information-contents-list">
            <div class="result-list">
              <div class="portal-information-list-title">
                <span class="link-txt">合成一覧のお知らせ</span>
              </div>
            </div>
            <div class="result-list portal-info-content-hide">
              <div class="portal-information-list-title">
                <span class="link-txt">非表示のお知らせ</span>
              </div>
            </div>
          </div>
        </main>
      `),
    );

    expect(context.scombz?.route).toBe("announcements");
    expect(context.scombz?.announcements).toEqual([
      { title: "合成一覧のお知らせ", url: null },
    ]);
  });

  it("extracts task rows in DOM order with the known selectors", () => {
    const context = parseScombzPageContext(
      { title: "課題", url: `${SCOMBZ_URL}/lms/task` },
      fixtureDocument("tasks"),
    );

    expect(context.scombz?.route).toBe("tasks");
    expect(context.scombz?.tasks).toEqual([
      {
        course: "合成コースA",
        title: "合成課題A",
        deadline: "2026-08-20",
        url: `${SCOMBZ_URL}/lms/task/synthetic-a`,
      },
      {
        course: "合成コースB",
        title: "合成課題B",
        deadline: "2026-08-21",
        url: `${SCOMBZ_URL}/lms/task/synthetic-b`,
      },
    ]);
  });

  it("recognizes course and timetable routes without inventing timetable courses", () => {
    const course = parseScombzPageContext(
      { title: "コース", url: `${SCOMBZ_URL}/course/synthetic-a` },
      fixtureDocument("course"),
    );
    const timetable = parseScombzPageContext(
      { title: "時間割", url: `${SCOMBZ_URL}/lms/timetable` },
      fixtureDocument("timetable"),
    );

    expect(course.scombz?.route).toBe("course");
    expect(course.scombz?.currentCourse).toEqual({
      name: "合成コースA",
      url: `${SCOMBZ_URL}/course/synthetic-a`,
    });
    expect(timetable.scombz?.route).toBe("timetable");
    expect(timetable.scombz?.currentCourse).toBeNull();
  });

  it("keeps unsafe links out while preserving nullable link fields", () => {
    const context = parseScombzPageContext(
      { title: "ScombZ", url: `${SCOMBZ_URL}/portal/home` },
      documentFromHtml(`
        <section id="top_information3">
          <div class="portal-info-content-part">
            <a href="javascript:alert(1)">安全でないお知らせ</a>
          </div>
        </section>
        <section id="school_link_list">
          <a class="portal-subblock-link-main-a" href="data:text/plain,bad">データ</a>
          <a class="portal-subblock-link-main-a" href="">空リンク</a>
        </section>
        <a class="portal-calendar-event-add-a" href="javascript:void(0)">Google</a>
        <a class="portal-calendar-event-export-a" href="data:text/plain,bad">ICS</a>
      `),
    );

    expect(context.scombz?.announcements).toEqual([
      { title: "安全でないお知らせ", url: null },
    ]);
    expect(context.scombz?.relatedLinks).toEqual([]);
    expect(context.scombz?.calendar).toEqual({
      googleCalendarUrl: null,
      icsUrl: null,
    });
  });

  it("excludes hidden announcement items, including the ScombZ hide class", () => {
    const context = parseScombzPageContext(
      { title: "ScombZ", url: `${SCOMBZ_URL}/portal/home` },
      documentFromHtml(`
        <section id="top_information3">
          <div class="portal-info-content-part" style="display: none">
            <a href="/notice/style">スタイル非表示</a>
          </div>
          <div class="portal-info-content-part" aria-hidden="true">
            <a href="/notice/aria">ARIA非表示</a>
          </div>
          <div class="portal-info-content-part portal-info-content-hide">
            <a href="/notice/class">クラス非表示</a>
          </div>
          <div class="portal-info-content-part">
            <a href="/notice/visible">表示されるお知らせ</a>
          </div>
          <div class="portal-info-content-part"><a href="/notice">一覧へ</a></div>
        </section>
      `),
    );

    expect(context.scombz?.announcements).toEqual([
      {
        title: "表示されるお知らせ",
        url: `${SCOMBZ_URL}/notice/visible`,
      },
    ]);
  });

  it("returns the unchanged base context for non-ScombZ pages", () => {
    const context = parseScombzPageContext(
      { title: "  Example  ", url: "https://example.com/page" },
      documentFromHtml("<p>not ScombZ</p>"),
    );

    expect(context).toEqual({
      title: "Example",
      url: "https://example.com/page",
      kind: "other",
    });
  });
});
