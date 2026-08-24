import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CastCareerSearchRequest,
  isCastCareerSearchRequest,
  mergeCastCareerSupportLocalResult,
  runCastCareerSourceSearch,
} from "./cast-career-source-runtime";
import {
  CAST_NOTION_RECORDING_URL,
  type CastSupportPageSnapshot,
} from "./cast-support-reader";

const topFixture = readFileSync(
  fileURLToPath(new URL("./fixtures/cast-support-top.html", import.meta.url)),
  "utf8",
);
const jobFixture = readFileSync(
  fileURLToPath(
    new URL("./fixtures/cast-opportunities-job.html", import.meta.url),
  ),
  "utf8",
);

function response(html: string, url: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => html,
  } as Response;
}

const jobForm = `
  <form action="/career/job_offer_search"><h1>求人情報検索</h1>
    <label>業種<select name="industry"><option value="software">情報通信（ソフトウェア）</option></select></label>
  </form>`;
const counseling = `<!doctype html><html><body>
  <h1>キャリア相談予約</h1><table><tbody>
    <tr><td>2026-09-01</td><td>10:00〜10:40</td><td>○</td></tr>
    <tr><td>2026-09-01</td><td>11:00〜11:40</td><td>×</td></tr>
  </tbody></table></body></html>`;

const companyForm = `<!doctype html><html><body>
  <form action="/career/company_search"><h1>企業検索 OB・OG 就活サポーター</h1>
    <input name="companyCode" value="" /><input name="employmentTabActive" value="" /><input name="companyExamTabActive" value="" />
  </form></body></html>`;
const companyResult = `<!doctype html><html><body>
  <p>該当数：1件</p>
  <form action="/career/company_detail_view"><input name="companyCode" value="" /><input name="employmentTabActive" value="" /><input name="companyExamTabActive" value="" /></form>
  <table><thead><tr><th>企業名</th><th>業種</th></tr></thead><tbody><tr>
    <td><a data-companycode="9500711" class="linkTo">合成精密株式会社</a></td><td>製造</td><td>採用実績 OB・OG 就活サポーター 入社試験情報</td>
  </tr></tbody></table></body></html>`;
const companyDetail = `<!doctype html><html><body>
  <form><input name="companyCode" value="9500711" /></form>
  <div>企業名</div><div>合成精密株式会社</div><div>企業コード</div><div>9500711</div>
  <section id="company_obog">OB・OG名簿 有</section>
</body></html>`;
const employmentFragment = `<!doctype html><html><body><section id="employment"><table><thead><tr><th>卒業年月</th><th>学問系統</th><th>学部学科</th><th>職種</th></tr></thead><tbody><tr><td>2024-03-20</td><td>理系</td><td>工学部 情報工学科</td><td>組込み開発</td></tr></tbody></table></section></body></html>`;
const examFragment = `<!doctype html><html><body><section id="company_exam_entry"><table><thead><tr><th>卒業年月</th><th>学問系統</th><th>学部学科</th><th>性別</th><th>応募方法</th><th>採用職種</th><th>参考ES</th></tr></thead><tbody><tr><td>2024-03-20</td><td>理系</td><td>工学部 情報工学科</td><td>回答しない</td><td>自由応募</td><td>組込み開発</td><td>有</td></tr></tbody></table></section></body></html>`;

function installDom() {
  vi.stubGlobal(
    "DOMParser",
    class {
      parseFromString(html: string) {
        return parseHTML(html).document;
      }
    },
  );
  vi.stubGlobal("window", {
    location: new URL("https://shibaura.pita.services/career/top/student"),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CAST career source runtime", () => {
  it("accepts semantic surfaces only and rejects arbitrary transport fields", () => {
    const valid: CastCareerSearchRequest = {
      query: "機械とプログラミング",
      surfaces: ["job", "company", "hiring_record"],
      filters: { locations: ["東京都"], obog_required: true },
      limit: 5,
    };
    expect(isCastCareerSearchRequest(valid)).toBe(true);
    expect(
      isCastCareerSearchRequest({
        ...valid,
        url: "https://evil.example.invalid",
      }),
    ).toBe(false);
    expect(
      isCastCareerSearchRequest({
        ...valid,
        surfaces: ["job", "job"],
      }),
    ).toBe(false);
    expect(
      isCastCareerSearchRequest({
        ...valid,
        filters: { ...valid.filters, company_code: "9500711" },
      }),
    ).toBe(false);
  });

  it("runs direct CAST search and counseling sequentially without returning hidden fields", async () => {
    installDom();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (
          url.endsWith("/career/job_offer_search") &&
          (init?.method ?? "GET") === "GET"
        )
          return response(jobForm, url);
        if (url.endsWith("/career/job_offer_search") && init?.method === "POST")
          return response(
            jobFixture,
            "https://shibaura.pita.services/career/job_offer_search/search",
          );
        if (url.endsWith("/career/consultation_reservation"))
          return response(counseling, url);
        throw new Error(`unexpected URL ${url}`);
      }),
    );
    const result = await runCastCareerSourceSearch({
      query: "情報系の求人と相談枠",
      surfaces: ["job", "counseling"],
      filters: {},
      limit: 5,
    });
    expect(result.status).toBe("known");
    expect(result.surface_results.map((surface) => surface.surface)).toEqual([
      "job",
      "counseling",
    ]);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: "job",
          company_name: "合成ロボティクス株式会社",
        }),
        expect.objectContaining({
          surface: "counseling",
          local_summary: "空き枠（予約操作は行っていません）",
        }),
      ]),
    );
    expect(calls).toEqual([
      "GET https://shibaura.pita.services/career/job_offer_search",
      "POST https://shibaura.pita.services/career/job_offer_search",
      "GET https://shibaura.pita.services/career/consultation_reservation",
    ]);
    expect(JSON.stringify(result)).not.toContain("student_id");
    expect(JSON.stringify(result)).not.toContain("csrf");
  });

  it("follows only the observed company detail and history fragment paths", async () => {
    installDom();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.includes("/career/company_search") &&
          (init?.method ?? "GET") === "GET"
        )
          return response(companyForm, url);
        if (url.includes("/career/company_search") && init?.method === "POST")
          return response(
            companyResult,
            "https://shibaura.pita.services/career/company_search/search",
          );
        if (
          url.endsWith("/career/adopters_search") &&
          (init?.method ?? "GET") === "GET"
        )
          return response(
            '<form action="/career/adopters_search"><h1>採用実績検索</h1></form>',
            url,
          );
        if (url.endsWith("/career/adopters_search") && init?.method === "POST")
          return response(
            "<p>該当数：0件</p>",
            "https://shibaura.pita.services/career/adopters_search/search",
          );
        if (url.endsWith("/career/company_detail_view"))
          return response(companyDetail, url);
        if (url.endsWith("/career/get/employmentSub"))
          return response(employmentFragment, url);
        if (url.endsWith("/career/get/companyExamSub"))
          return response(examFragment, url);
        throw new Error(`unexpected URL ${url}`);
      }),
    );
    const result = await runCastCareerSourceSearch({
      query: "採用実績と選考記録",
      surfaces: ["company", "hiring_record", "selection_report"],
      filters: {},
      limit: 5,
    });
    expect(
      result.surface_results.find(
        (surface) => surface.surface === "hiring_record",
      ),
    ).toEqual(expect.objectContaining({ status: "known", returned_count: 1 }));
    expect(
      result.surface_results.find(
        (surface) => surface.surface === "selection_report",
      ),
    ).toEqual(expect.objectContaining({ status: "known", returned_count: 1 }));
    expect(JSON.stringify(result)).not.toContain("9500711");
    expect(JSON.stringify(result)).not.toContain("山田");
  });

  it("discovers only CAST-linked support roots and merges a local Notion snapshot", async () => {
    installDom();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url.endsWith("/career/job_offer_search") &&
          (init?.method ?? "GET") === "GET"
        )
          return response(jobForm, url);
        if (url.endsWith("/career/job_offer_search") && init?.method === "POST")
          return response(
            jobFixture,
            "https://shibaura.pita.services/career/job_offer_search/search",
          );
        if (url.endsWith("/career/top/student"))
          return response(topFixture, url);
        throw new Error(`unexpected URL ${url}`);
      }),
    );
    const local = await runCastCareerSourceSearch({
      query: "見るべき録画",
      surfaces: ["job", "recording"],
      filters: {},
      limit: 5,
    });
    expect(local.discovered_support_links).toEqual([
      { kind: "recording", url: CAST_NOTION_RECORDING_URL },
    ]);
    expect(
      local.surface_results.find((item) => item.surface === "recording")
        ?.status,
    ).toBe("partial");
    const snapshot: CastSupportPageSnapshot = {
      schema_version: "v1",
      status: "known",
      kind: "recording",
      source_url: CAST_NOTION_RECORDING_URL,
      items: [
        {
          title: "ES講座録画",
          date: "2026-08-20",
          target: "学部生",
          summary: "公開講座",
        },
      ],
    };
    const merged = mergeCastCareerSupportLocalResult(local, [
      { kind: "recording", result: snapshot },
    ]);
    expect(merged.status).toBe("known");
    expect(merged.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "recording", title: "ES講座録画" }),
      ]),
    );
    expect(JSON.stringify(merged)).not.toContain("zoom");
  });
});
