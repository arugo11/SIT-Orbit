import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAST_SEARCH_DEFINITIONS,
  type CastSearchRequest,
  clearCastSearchCursors,
  collectCastSearchFormCatalog,
  isCastSearchRequest,
  projectCastSearchForAgent,
  runCastSearch,
} from "./cast-search-api";

function response(html: string, url: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => html,
  } as Response;
}

const jobForm = `
  <form action="/career/job_offer_search" method="post">
    <h1>求人情報検索</h1>
    <input type="hidden" name="csrf" value="secret-hidden-value" />
    <label for="company">企業名</label><input id="company" name="company" />
    <label for="industry">業種</label>
    <select id="industry" name="industry" multiple>
      <option value="manufacturing">製造（生産用機器）</option>
      <option value="software">情報通信（ソフトウェア）</option>
    </select>
    <label for="page">ページ番号</label><input id="page" name="csc.currentPageNumber" />
    <button type="submit">検索</button>
  </form>`;

const jobResult = `
  <p>該当数：1件</p>
  <section class="panel panel-default">
    <div class="panel-heading"><a class="view-detail">求人情報詳細</a><span>受付中</span><span>求人受付日：2026-08-21</span><span>応募締切日：2027-03-31</span></div>
    <div class="panel-body">
      <div class="row"><div class="cell-th">企業名</div><div class="cell-td"><a class="linkTo">合成ロボティクス株式会社</a></div></div>
      <div class="row"><div class="cell-th">業種</div><div class="cell-td">製造（生産用機器）、情報通信（ソフトウェア）</div></div>
      <div class="row"><div class="cell-th">募集職種</div><div class="cell-td">開発・設計、ＳＥ・プログラマー等</div></div>
      <div class="row"><div class="cell-th">勤務地</div><div class="cell-td">東京都</div></div>
      <div class="row"><div class="cell-th">募集学部学科</div><div class="cell-td">機械工学科、情報工学科</div></div>
      <div class="row"><div class="cell-th">本学との関連</div><div class="cell-td">採用実績、OB・OG名簿</div></div>
    </div>
  </section>`;

const companyForm = `
  <form action="/career/company_search" method="post">
    <h1>企業検索</h1><label for="company">企業名</label><input id="company" name="company" />
    <label for="relation">本学との関連</label><select id="relation" name="relation"><option value="obog">OB・OG</option></select>
    <label for="company-page">ページ番号</label><input id="company-page" name="csc.currentPageNumber" />
    <button type="submit">検索</button>
  </form>`;

const companyResult = `
  <p>該当数：1件</p>
  <table><thead><tr><th>企業名</th><th>業種</th><th>OB・OG</th></tr></thead>
    <tbody><tr><td>合成ロボティクス株式会社</td><td>製造（生産用機器）</td><td>有</td></tr></tbody>
  </table>`;

describe("CAST direct search transport", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: new URL(
        "https://shibaura.pita.services/career/job_offer_search",
      ),
    });
    clearCastSearchCursors();
  });

  it("accepts only semantic requests and rejects URL/form injection", () => {
    const valid: CastSearchRequest = {
      kind: "job",
      filters: { company_name: "ロボティクス", industries: ["製造"] },
    };
    expect(isCastSearchRequest(valid)).toBe(true);
    expect(
      isCastSearchRequest({
        kind: "job",
        filters: { company_name: "x" },
        url: "https://attacker.example/steal",
      }),
    ).toBe(false);
    expect(
      isCastSearchRequest({ kind: "job", filters: {}, form_action: "/evil" }),
    ).toBe(false);
    expect(
      isCastSearchRequest({
        kind: "job",
        filters: { company_name: "x", field_name: "csrf" },
      }),
    ).toBe(false);
    expect(
      isCastSearchRequest({
        kind: "job",
        filters: { industries: "情報通信" },
      }),
    ).toBe(false);
  });

  it("catalogues the observed form action without exposing hidden field values", () => {
    const { document } = parseHTML(jobForm);
    const catalog = collectCastSearchFormCatalog(
      document,
      "job",
      `${CAST_SEARCH_DEFINITIONS.job.kind === "job" ? "https://shibaura.pita.services/career/job_offer_search" : ""}`,
    );
    expect(catalog).not.toBeNull();
    expect(catalog?.controls.map((control) => control.name)).toContain(
      "company",
    );
    expect(catalog?.controls.map((control) => control.name)).not.toContain(
      "csrf",
    );
    expect(JSON.stringify(catalog)).not.toContain("secret-hidden-value");
  });

  it("preserves hidden form state only inside same-origin POST and returns typed data", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await runCastSearch(
      {
        kind: "job",
        filters: {
          company_name: "ロボティクス",
          industries: ["製造（生産用機器）"],
        },
      },
      {
        parseHtml: (html) => parseHTML(html).document,
        fetcher: async (input, init) => {
          const url = String(input);
          calls.push({ url, init });
          return calls.length === 1
            ? response(
                jobForm,
                "https://shibaura.pita.services/career/job_offer_search",
              )
            : response(
                jobResult,
                "https://shibaura.pita.services/career/job_offer_search/search",
              );
        },
      },
    );
    expect(result.status).toBe("known");
    if (result.status !== "known") return;
    expect(result.total_count).toBe(1);
    expect(result.typed_items[0]).toEqual(
      expect.objectContaining({
        company_name: "合成ロボティクス株式会社",
        deadline: "2027-03-31",
      }),
    );
    expect(result.local_evidence[0]?.locator).toMatch(
      /^orbit-cast:\/\/search\//u,
    );
    const postBody = calls[1]?.init?.body;
    expect(postBody).toBeInstanceOf(FormData);
    expect(postBody && (postBody as FormData).get("csrf")).toBe(
      "secret-hidden-value",
    );
    expect(JSON.stringify(result)).not.toContain("secret-hidden-value");
    expect(JSON.stringify(result)).not.toContain("data-companycode");
  });

  it("maps an exact observed company relation filter and rejects drift", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await runCastSearch(
      { kind: "company", filters: { relation: "obog" } },
      {
        parseHtml: (html) => parseHTML(html).document,
        fetcher: async (input, init) => {
          calls.push({ url: String(input), init });
          return calls.length === 1
            ? response(
                companyForm,
                "https://shibaura.pita.services/career/company_search?common_header=on",
              )
            : response(
                companyResult,
                "https://shibaura.pita.services/career/company_search/search",
              );
        },
      },
    );
    expect(result.status).toBe("known");
    const formData = calls[1]?.init?.body as FormData;
    expect(formData.get("relation")).toBe("obog");

    const drift = await runCastSearch(
      { kind: "company", filters: { relation: "obog" } },
      {
        parseHtml: (html) => parseHTML(html).document,
        fetcher: async (input) =>
          response(
            '<form action="/career/unknown"><h1>企業検索</h1></form>',
            String(input),
          ),
      },
    );
    expect(drift).toEqual({
      status: "form_changed",
      reason_code: "search_form_changed",
    });
  });

  it("fails closed when a requested semantic filter is absent from the form", async () => {
    const calls: string[] = [];
    const result = await runCastSearch(
      { kind: "company", filters: { locations: ["東京都"] } },
      {
        parseHtml: (html) => parseHTML(html).document,
        fetcher: async (input) => {
          calls.push(String(input));
          return response(
            companyForm,
            "https://shibaura.pita.services/career/company_search?common_header=on",
          );
        },
      },
    );
    expect(result).toEqual({
      status: "form_changed",
      reason_code: "filter_not_available",
    });
    expect(calls).toHaveLength(1);
  });

  it("supports the five observed search surfaces with typed result parsing", async () => {
    const cases = [
      {
        kind: "internship" as const,
        form: '<form action="/career/internship_search"><h1>インターンシップ情報検索</h1><label>実施地<select name="place"><option value="tokyo">東京都</option></select></label></form>',
        result:
          '<p>該当数：1件</p><section class="panel panel-default"><div class="panel-heading"><a class="view-detail">インターンシップ詳細</a><span>受付中</span><span>応募締切日：2026-09-12</span></div><div class="panel-body"><div class="row"><div class="cell-th">企業名</div><div class="cell-td"><a class="linkTo">合成メカトロ株式会社</a></div><div class="cell-th">実施地</div><div class="cell-td">東京都</div></div></div></section>',
        resultUrl: "https://shibaura.pita.services/career/internship_search",
      },
      {
        kind: "company_session" as const,
        form: '<form action="/career/company_session_search"><h1>会社説明会情報検索</h1><label>業種<select name="industry"><option value="robot">製造</option></select></label></form>',
        result:
          "<p>該当数：1件</p><table><thead><tr><th>企業名</th><th>業種</th><th>開催日</th></tr></thead><tbody><tr><td>合成説明会株式会社</td><td>製造</td><td>2026-09-01</td></tr></tbody></table>",
        resultUrl:
          "https://shibaura.pita.services/career/company_session_search",
      },
      {
        kind: "hiring_record" as const,
        form: '<form action="/career/adopters_search"><h1>採用実績検索</h1><label>卒業年度<select name="year" multiple><option value="2026">2026</option><option value="2025">2025</option><option value="2024">2024</option><option value="2023">2023</option><option value="2022">2022</option></select></label></form>',
        result:
          "<p>該当数：1件</p><table><thead><tr><th>企業名</th><th>業種</th><th>卒業年度</th><th>学部学科</th><th>採用人数</th></tr></thead><tbody><tr><td>合成採用株式会社</td><td>情報通信</td><td>2024</td><td>情報工学科</td><td>6</td></tr></tbody></table>",
        resultUrl:
          "https://shibaura.pita.services/career/adopters_search/search",
      },
    ];
    for (const item of cases) {
      const result = await runCastSearch(
        { kind: item.kind, filters: {} },
        {
          parseHtml: (html) => parseHTML(html).document,
          fetcher: async (input, init) => {
            const method = init?.method ?? "GET";
            return method === "GET"
              ? response(item.form, String(input))
              : response(item.result, item.resultUrl);
          },
        },
      );
      expect(result.status, item.kind).toBe("known");
      if (result.status === "known") expect(result.typed_items).toHaveLength(1);
    }
  });

  it("uses an opaque cursor for the next page and only completes an explicit exhaustive request", async () => {
    let postCount = 0;
    const firstPage =
      "<p>該当数：11件</p><table><thead><tr><th>企業名</th></tr></thead><tbody><tr><td>企業1</td></tr></tbody></table>";
    const secondPage =
      "<p>該当数：11件</p><table><thead><tr><th>企業名</th></tr></thead><tbody><tr><td>企業2</td></tr></tbody></table>";
    const request = { kind: "company" as const, filters: {} };
    const run = () =>
      runCastSearch(request, {
        parseHtml: (html) => parseHTML(html).document,
        fetcher: async (input, init) => {
          if ((init?.method ?? "GET") === "GET")
            return response(companyForm, String(input));
          postCount += 1;
          return response(
            postCount === 1 ? firstPage : secondPage,
            "https://shibaura.pita.services/career/company_search/search",
          );
        },
      });
    const first = await run();
    expect(first.status).toBe("known");
    if (first.status !== "known" || !first.next_cursor) return;
    const next = await runCastSearch(
      { ...request, cursor: first.next_cursor },
      {
        parseHtml: (html) => parseHTML(html).document,
        fetcher: async (input, init) => {
          if ((init?.method ?? "GET") === "GET")
            return response(companyForm, String(input));
          return response(
            secondPage,
            "https://shibaura.pita.services/career/company_search/search",
          );
        },
      },
    );
    expect(next.status).toBe("known");
    expect(next && next.status === "known" ? next.page : null).toBe(2);
  });

  it("does not turn login, 404, rate limit, or server errors into empty results", async () => {
    const run = (status: number, html = "") =>
      runCastSearch(
        { kind: "job", filters: {} },
        {
          parseHtml: (value) => parseHTML(value).document,
          fetcher: async (input) => response(html, String(input), status),
        },
      );
    await expect(run(404)).resolves.toEqual({
      status: "unavailable",
      reason_code: "not_found",
    });
    await expect(run(429)).resolves.toEqual({
      status: "rate_limited",
      reason_code: "cast_rate_limited",
    });
    await expect(run(500)).resolves.toEqual({
      status: "unavailable",
      reason_code: "cast_server_error",
    });
    await expect(run(200, '<input type="password" />')).resolves.toEqual({
      status: "reauth_required",
      reason_code: "login_required",
    });
  });

  it("suppresses small aggregate cells at the agent boundary", () => {
    const result = {
      status: "known" as const,
      applied_filters: {
        kind: "hiring_record" as const,
        filters: {},
        sort: null,
        graduation_years_defaulted: true,
      },
      total_count: 6,
      coverage: {
        mode: "page" as const,
        page_size: 10,
        fetched_pages: 1,
        total_pages: 1,
      },
      page: 1,
      next_cursor: null,
      typed_items: Array.from({ length: 6 }, (_, index) => ({
        item_ref: `local-${index}`,
        kind: "hiring_record" as const,
        title: "企業",
        company_name: "企業",
        industry: ["情報通信"],
        locations: [],
        occupations: [],
        academic_programs: [],
        deadline: null,
        graduation_year: 2024,
        hiring_count: 1,
        relation_flags: [],
        local_summary: null,
      })),
      local_evidence: [
        {
          evidence_id: "web-search-v1-test",
          title: "CAST",
          locator: "orbit-cast://search/test",
        },
      ],
    };
    expect(projectCastSearchForAgent(result).anonymous_aggregates).toEqual([
      { dimension: "industry", value: "情報通信", count: 6 },
      { dimension: "graduation_year", value: "2024", count: 6 },
    ]);
    expect(JSON.stringify(projectCastSearchForAgent(result))).not.toContain(
      "企業",
    );
  });
});
