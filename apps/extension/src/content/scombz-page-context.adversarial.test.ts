import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { parseScombzPageContext } from "./page-context";

const SCOMBZ_URL = "https://scombz.shibaura-it.ac.jp";

function documentFromHtml(html: string): Document {
  return parseHTML(html).document;
}

describe("ScombZ adapter adversarial boundaries", () => {
  it("does not turn hidden task rows into evidence", () => {
    const context = parseScombzPageContext(
      { title: "課題", url: `${SCOMBZ_URL}/lms/task` },
      documentFromHtml(`
        <main id="taskList">
          <div class="result_list_line" hidden>
            <span class="course">非表示コース</span>
            <div class="tasklist-title"><a href="/task/hidden">非表示課題</a></div>
            <div class="tasklist-deadline"><span class="deadline">2026-08-20</span></div>
          </div>
          <div class="result_list_line" style="display: none">
            <span class="course">CSS非表示コース</span>
            <div class="tasklist-title"><a href="/task/css-hidden">CSS非表示課題</a></div>
            <div class="tasklist-deadline"><span class="deadline">2026-08-21</span></div>
          </div>
          <div class="result_list_line">
            <span class="course">表示コース</span>
            <div class="tasklist-title"><a href="/task/visible">表示課題</a></div>
            <div class="tasklist-deadline"><span class="deadline">2026-08-22</span></div>
          </div>
        </main>
      `),
    );

    expect(context.scombz?.tasks).toEqual([
      {
        course: "表示コース",
        title: "表示課題",
        deadline: "2026-08-22",
        url: `${SCOMBZ_URL}/task/visible`,
      },
    ]);
  });

  it("keeps unsafe task URLs nullable instead of returning them", () => {
    const context = parseScombzPageContext(
      { title: "課題", url: `${SCOMBZ_URL}/lms/task` },
      documentFromHtml(`
        <main id="taskList">
          <div class="result_list_line">
            <span class="course">安全確認コース</span>
            <div class="tasklist-title">
              <a href="javascript:alert(1)">不正URL課題</a>
            </div>
            <div class="tasklist-deadline"><span class="deadline">2026-08-23</span></div>
          </div>
        </main>
      `),
    );

    expect(context.scombz?.tasks).toEqual([
      {
        course: "安全確認コース",
        title: "不正URL課題",
        deadline: "2026-08-23",
        url: null,
      },
    ]);
  });

  it("does not turn hidden links into evidence", () => {
    const context = parseScombzPageContext(
      { title: "ホーム", url: `${SCOMBZ_URL}/portal/home` },
      documentFromHtml(`
        <section id="school_link_list">
          <div hidden>
            <a class="portal-subblock-link-main-a" href="/links/hidden">非表示リンク</a>
          </div>
          <a class="portal-subblock-link-main-a" href="/links/visible">表示リンク</a>
        </section>
        <footer>
          <a class="portal-subblock-link-main-a" href="/links/footer">フッターのノイズ</a>
        </footer>
      `),
    );

    expect(context.scombz?.relatedLinks).toEqual([
      {
        label: "表示リンク",
        url: `${SCOMBZ_URL}/links/visible`,
      },
    ]);
  });

  it("does not turn hidden calendar controls into evidence", () => {
    const context = parseScombzPageContext(
      { title: "ホーム", url: `${SCOMBZ_URL}/portal/home` },
      documentFromHtml(`
        <a class="portal-calendar-event-add-a" hidden href="/calendar/hidden-google">Hidden Google</a>
        <a class="portal-calendar-event-add-a" href="/calendar/visible-google">Visible Google</a>
        <a class="portal-calendar-event-export-a" style="visibility: collapse" href="/calendar/hidden-ics">Hidden ICS</a>
        <a class="portal-calendar-event-export-a" href="/calendar/visible.ics">Visible ICS</a>
      `),
    );

    expect(context.scombz?.calendar).toEqual({
      googleCalendarUrl: `${SCOMBZ_URL}/calendar/visible-google`,
      icsUrl: `${SCOMBZ_URL}/calendar/visible.ics`,
    });
  });

  it("falls back to the notification list when the announcement root has no visible rows", () => {
    const context = parseScombzPageContext(
      {
        title: "お知らせ一覧",
        url: `${SCOMBZ_URL}/portal/home/information/list`,
      },
      documentFromHtml(`
        <section id="top_information3">
          <div class="portal-info-content-part" hidden>
            <a href="/notice/hidden">非表示のお知らせ</a>
          </div>
          <div class="portal-info-content-part">一覧へ</div>
        </section>
        <main id="informationDataList">
          <div class="result-list">
            <div class="portal-information-list-title">
              <span class="link-txt">通知一覧の表示項目</span>
            </div>
          </div>
          <div class="result-list" aria-hidden="true">
            <div class="portal-information-list-title">
              <span class="link-txt">通知一覧の非表示項目</span>
            </div>
          </div>
        </main>
      `),
    );

    expect(context.scombz?.announcements).toEqual([
      { title: "通知一覧の表示項目", url: null },
    ]);
  });

  it("reads only the supplied DOM and does not call network or storage APIs", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("network access is forbidden in this adapter");
    });
    const storageGetMock = vi.fn(() => {
      throw new Error("storage access is forbidden in this adapter");
    });
    const previousFetch = globalThis.fetch;
    const previousChrome = (globalThis as { chrome?: unknown }).chrome;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { storage: { local: { get: storageGetMock } } },
    });

    try {
      expect(() =>
        parseScombzPageContext(
          { title: "ScombZ", url: `${SCOMBZ_URL}/portal/home` },
          documentFromHtml('<section id="top_information3"></section>'),
        ),
      ).not.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(storageGetMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: previousFetch,
      });
      if (previousChrome === undefined) {
        Reflect.deleteProperty(globalThis, "chrome");
      } else {
        Object.defineProperty(globalThis, "chrome", {
          configurable: true,
          value: previousChrome,
        });
      }
    }
  });
});
