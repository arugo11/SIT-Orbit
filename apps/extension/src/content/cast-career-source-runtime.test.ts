import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CareerVault,
  MemorySessionKeyStore,
  MemoryVaultStore,
} from "../privacy/career-vault";
import { PseudonymizationGateway } from "../privacy/pseudonymization";
import {
  buildCastCareerLocalReasoningProjection,
  buildCastCareerReasoningSnapshot,
  CAST_COMPANY_EXAM_REPORT_URL,
  type CastCareerLocalResult,
  type CastCareerSearchRequest,
  type CastCareerSourceItem,
  isCastCareerSearchRequest,
  mergeCastCareerSupportLocalResult,
  projectCastCareerForAgent,
  runCastCareerSourceSearch,
} from "./cast-career-source-runtime";
import {
  CAST_NOTION_EVENT_URL,
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
const internshipFixture = readFileSync(
  fileURLToPath(
    new URL("./fixtures/cast-opportunities-internship.html", import.meta.url),
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
const internshipForm = `<!doctype html><html><body>
  <form action="/career/internship_search"><h1>インターンシップ検索</h1><p>実施時期・対象学年</p>
    <label>実施地<select name="location"><option value="toyosu">豊洲</option></select></label>
    <label>対象学年<select name="grade"><option value="third">学部3年</option></select></label>
  </form>
</body></html>`;
const companySessionForm = `<!doctype html><html><body>
  <form action="/career/company_session_search"><h1>会社説明会検索</h1><p>開催日・開催地</p>
    <label>開催地<select name="location"><option value="toyosu">豊洲</option></select></label>
  </form>
</body></html>`;
const companySessionResult = `<!doctype html><html><body>
  <h1>会社説明会 開催</h1><p>該当数：1件</p>
  <table><thead><tr><th>企業名</th><th>開催日</th></tr></thead><tbody>
    <tr><td>合成説明会企業</td><td>2026-09-10</td></tr>
  </tbody></table>
</body></html>`;
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
const publishedExamReport = `<!doctype html><html><body><section id="company_exam_entry"><table><thead><tr><th>卒業年月</th><th>学問系統</th><th>学部学科</th><th>性別</th><th>応募方法</th><th>採用職種</th><th>参考ES</th></tr></thead><tbody><tr><td>2025-03-20</td><td>理系</td><td>工学部 機械工学科</td><td>回答しない</td><td>自由応募</td><td>設計</td><td>有</td></tr></tbody></table></section></body></html>`;

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
  it("builds a local reasoning snapshot without URLs or local summaries", () => {
    const local: CastCareerLocalResult = {
      schema_version: "v1",
      status: "known",
      query: "MLエンジニア",
      surfaces: ["hiring_record", "selection_report"],
      surface_results: [],
      items: [
        {
          result_ref: "orbit-cast-hiring_record-12345678",
          surface: "hiring_record",
          title: "サンプル技研 採用実績",
          company_name: "サンプル技研",
          dates: ["2024-03-20"],
          deadline: null,
          locations: [],
          industries: ["情報通信"],
          occupations: ["MLエンジニア"],
          academic_programs: ["機械学習"],
          employment_types: ["正社員"],
          graduation_years: [2024],
          relation_flags: ["obog", "hiring_record"],
          local_summary: "内部の詳細説明は送らない",
          source_url:
            "https://shibaura.pita.services/career/company_detail_view",
        },
      ],
      local_evidence: [],
      discovered_support_links: [],
      reason_codes: [],
    };
    const snapshot = buildCastCareerReasoningSnapshot(local);
    expect(snapshot).toEqual({
      schema_version: "v2",
      records: [
        expect.objectContaining({
          surface: "hiring_record",
          title: "サンプル技研 採用実績",
          company_name: "サンプル技研",
          result_ref: "orbit-cast-hiring_record-12345678",
        }),
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("local_summary");
    expect(JSON.stringify(snapshot)).not.toContain("source_url");
  });

  it("creates a local-only pseudonymized reasoning projection from typed CAST rows", async () => {
    const vault = new CareerVault({
      store: new MemoryVaultStore(),
      sessionKeyStore: new MemorySessionKeyStore(),
    });
    await vault.create("career-runtime-test-passphrase");
    try {
      const mission = await new PseudonymizationGateway(vault).startMission(
        "cast-career-runtime-test",
      );
      const local: CastCareerLocalResult = {
        schema_version: "v1",
        status: "known",
        query: "選考記録",
        surfaces: ["selection_report"],
        surface_results: [],
        items: [
          {
            result_ref: "orbit-cast-selection_report-12345678",
            surface: "selection_report",
            title: "選考記録",
            company_name: "サンプル技研",
            dates: ["2026-08-20"],
            deadline: null,
            locations: ["東京都"],
            industries: [],
            occupations: ["MLエンジニア"],
            academic_programs: ["情報工学"],
            graduation_years: [2024],
            relation_flags: ["selection_report"],
            local_summary: "非公開の選考本文",
            source_url: null,
          },
        ],
        local_evidence: [],
        discovered_support_links: [],
        reason_codes: [],
      };
      const result = await buildCastCareerLocalReasoningProjection(
        local,
        mission,
      );
      expect(result.payload.destination).toBe("local");
      expect(result.payload.records).toHaveLength(1);
      expect(result.payload.records[0]).toEqual(
        expect.objectContaining({
          surface: "selection_report",
          company_name: "サンプル技研",
          graduation_year_buckets: ["2020-2024"],
        }),
      );
      expect(result.manifest.destination).toBe("local");
      expect(JSON.stringify(result)).not.toContain("非公開");
    } finally {
      await vault.lock();
    }
  });

  it("projects nine-surface details into aggregate-only agent data", () => {
    const item = (index: number): CastCareerSourceItem => ({
      result_ref: `orbit-cast-result-${index}`,
      surface: "job",
      title: `企業${index}`,
      company_name: `企業${index}`,
      dates: ["2026-08-20"],
      deadline: "2026-09-30",
      locations: ["豊洲"],
      industries: ["情報通信"],
      occupations: ["組込み開発"],
      academic_programs: ["機械工学"],
      graduation_years: [2026],
      relation_flags: ["obog"],
      local_summary: "個人名 山田太郎、連絡先 test@example.com",
      source_url:
        "https://shibaura.pita.services/career/job_offer_search/search",
    });
    const local: CastCareerLocalResult = {
      schema_version: "v1",
      status: "known",
      query: "機械系の求人",
      surfaces: ["job", "recording", "counseling"],
      surface_results: [
        {
          surface: "job",
          status: "known",
          total_count: 8,
          returned_count: 8,
          coverage: { mode: "page", fetched_pages: 1, page_size: 10 },
          items: Array.from({ length: 8 }, (_, index) => item(index)),
          reason_code: null,
          evidence_ids: ["local-only-evidence"],
        },
        {
          surface: "recording",
          status: "unavailable",
          total_count: null,
          returned_count: 0,
          coverage: null,
          items: [],
          reason_code: "support_read_pending",
          evidence_ids: [],
        },
        {
          surface: "counseling",
          status: "known",
          total_count: 2,
          returned_count: 2,
          coverage: { mode: "page", fetched_pages: 1, page_size: 10 },
          items: [],
          reason_code: null,
          evidence_ids: [],
        },
      ],
      items: Array.from({ length: 8 }, (_, index) => item(index)),
      local_evidence: [
        {
          evidence_id: "local-only-evidence",
          title: "個人名を含むローカル根拠",
          locator: "orbit-cast://career/local-only",
        },
      ],
      discovered_support_links: [],
      reason_codes: ["support_read_pending"],
    };

    const projection = projectCastCareerForAgent(local);
    expect(projection.status).toBe("partial");
    expect(projection.searched_surfaces).toEqual([
      "job",
      "recording",
      "counseling",
    ]);
    expect(projection.evidence_ids).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain("企業0");
    expect(JSON.stringify(projection)).not.toContain("山田太郎");
    expect(JSON.stringify(projection)).not.toContain("example.com");
    expect(JSON.stringify(projection)).not.toContain("shibaura.pita.services");
    expect(projection.anonymous_aggregates).toEqual(
      expect.arrayContaining([
        { dimension: "industry", value: "情報通信", count: 8 },
        { dimension: "location", value: "豊洲", count: 8 },
        { dimension: "relation", value: "obog", count: 8 },
      ]),
    );
    expect(
      projection.anonymous_aggregates.some(
        (aggregate) =>
          aggregate.dimension === "surface" && aggregate.value === "counseling",
      ),
    ).toBe(false);
  });

  it("does not label an all-failed run as partial", () => {
    const local: CastCareerLocalResult = {
      schema_version: "v1",
      status: "partial",
      query: "CAST検索",
      surfaces: ["job", "recording"],
      surface_results: [
        {
          surface: "job",
          status: "unavailable",
          total_count: null,
          returned_count: 0,
          coverage: null,
          items: [],
          reason_code: "cast_server_error",
          evidence_ids: [],
        },
        {
          surface: "recording",
          status: "partial",
          total_count: null,
          returned_count: 0,
          coverage: null,
          items: [],
          reason_code: "support_read_pending",
          evidence_ids: [],
        },
      ],
      items: [],
      local_evidence: [],
      discovered_support_links: [],
      reason_codes: ["cast_server_error", "support_read_pending"],
    };
    const projection = projectCastCareerForAgent(local);
    expect(projection.status).toBe("unavailable");
    expect(projection.total_count).toBe(0);
    expect(projection.returned_count).toBe(0);
    expect(projection.anonymous_aggregates).toEqual([]);
  });

  it("keeps partial surfaces with returned rows usable", () => {
    const local: CastCareerLocalResult = {
      schema_version: "v1",
      status: "partial",
      query: "採用実績",
      surfaces: ["hiring_record"],
      surface_results: [
        {
          surface: "hiring_record",
          status: "partial",
          total_count: null,
          returned_count: 1,
          coverage: { mode: "partial", fetched_pages: 1, page_size: 10 },
          items: [
            {
              result_ref: "orbit-cast-result-local",
              surface: "hiring_record",
              title: "採用実績",
              company_name: "合成企業",
              dates: ["2026"],
              deadline: null,
              locations: [],
              industries: ["情報通信"],
              occupations: [],
              academic_programs: [],
              graduation_years: [2026],
              relation_flags: [],
              local_summary: null,
              source_url: null,
            },
          ],
          reason_code: "company_detail_partial",
          evidence_ids: [],
        },
      ],
      items: [],
      local_evidence: [],
      discovered_support_links: [],
      reason_codes: ["company_detail_partial"],
    };
    const projection = projectCastCareerForAgent(local);
    expect(projection.status).toBe("partial");
    expect(projection.returned_count).toBe(1);
  });

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
    expect(isCastCareerSearchRequest({ ...valid, limit: 21 })).toBe(false);
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

  it("runs internship and company-session surfaces through their observed forms", async () => {
    installDom();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (
          url.endsWith("/career/internship_search") &&
          (init?.method ?? "GET") === "GET"
        )
          return response(internshipForm, url);
        if (
          url.endsWith("/career/internship_search") &&
          init?.method === "POST"
        )
          return response(
            internshipFixture,
            "https://shibaura.pita.services/career/internship_search",
          );
        if (
          url.endsWith("/career/company_session_search") &&
          (init?.method ?? "GET") === "GET"
        )
          return response(companySessionForm, url);
        if (
          url.endsWith("/career/company_session_search") &&
          init?.method === "POST"
        )
          return response(
            companySessionResult,
            "https://shibaura.pita.services/career/company_session_search",
          );
        throw new Error(`unexpected URL ${url}`);
      }),
    );
    const result = await runCastCareerSourceSearch({
      query: "インターンと会社説明会",
      surfaces: ["internship", "company_session"],
      filters: { target_grades: ["学部3年"] },
      limit: 5,
    });
    expect(result.status).toBe("known");
    expect(result.surface_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: "internship",
          status: "known",
          returned_count: 1,
        }),
        expect.objectContaining({
          surface: "company_session",
          status: "known",
          returned_count: 1,
        }),
      ]),
    );
    expect(result.items.map((item) => item.surface)).toEqual([
      "internship",
      "company_session",
    ]);
    expect(calls).toEqual([
      "GET https://shibaura.pita.services/career/internship_search",
      "POST https://shibaura.pita.services/career/internship_search",
      "GET https://shibaura.pita.services/career/company_session_search",
      "POST https://shibaura.pita.services/career/company_session_search",
    ]);
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

  it("discovers both CAST-linked support roots and merges local Notion snapshots", async () => {
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
      query: "見るべき録画とイベント",
      surfaces: ["job", "recording", "career_event"],
      filters: {},
      limit: 5,
    });
    expect(local.discovered_support_links).toEqual([
      { kind: "recording", url: CAST_NOTION_RECORDING_URL },
      { kind: "career_event", url: CAST_NOTION_EVENT_URL },
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
    const eventSnapshot: CastSupportPageSnapshot = {
      ...snapshot,
      kind: "career_event",
      source_url: CAST_NOTION_EVENT_URL,
      items: [
        {
          title: "会社説明会スケジュール",
          date: "2026-08-21",
          target: "学部生",
          summary: "公開イベント",
        },
      ],
    };
    const merged = mergeCastCareerSupportLocalResult(local, [
      { kind: "recording", result: snapshot },
      { kind: "career_event", result: eventSnapshot },
    ]);
    expect(merged.status).toBe("known");
    expect(merged.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: "recording", title: "ES講座録画" }),
        expect.objectContaining({
          surface: "career_event",
          title: "会社説明会スケジュール",
        }),
      ]),
    );
    expect(JSON.stringify(merged)).not.toContain("zoom");
  });

  it("follows the published exam route only when the detail DOM exposes it", async () => {
    installDom();
    const detailWithObservedReport = companyDetail.replace(
      "</body>",
      `<a href="${CAST_COMPANY_EXAM_REPORT_URL}">入社試験情報の報告</a></body>`,
    );
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
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
        if (url.endsWith("/career/company_detail_view"))
          return response(detailWithObservedReport, url);
        if (url.endsWith("/career/get/employmentSub"))
          return response(employmentFragment, url);
        if (url === CAST_COMPANY_EXAM_REPORT_URL)
          return response(publishedExamReport, url);
        throw new Error(`unexpected URL ${url}`);
      }),
    );
    const result = await runCastCareerSourceSearch({
      query: "選考記録",
      surfaces: ["company", "selection_report"],
      filters: {},
      limit: 5,
    });
    expect(
      result.surface_results.find(
        (surface) => surface.surface === "selection_report",
      ),
    ).toEqual(expect.objectContaining({ status: "known", returned_count: 1 }));
    expect(calls).toContain(`GET ${CAST_COMPANY_EXAM_REPORT_URL}`);
    expect(calls).not.toContain(
      "POST https://shibaura.pita.services/career/get/companyExamSub",
    );
  });

  it("does not fetch an unrelated selection fragment for hiring-only searches", async () => {
    installDom();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
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
        if (url.endsWith("/career/company_detail_view"))
          return response(companyDetail, url);
        if (url.endsWith("/career/get/employmentSub"))
          return response(employmentFragment, url);
        throw new Error(`unexpected URL ${url}`);
      }),
    );
    const result = await runCastCareerSourceSearch({
      query: "採用実績だけ",
      surfaces: ["company", "hiring_record"],
      filters: {},
      limit: 5,
    });
    expect(
      result.surface_results.find(
        (surface) => surface.surface === "hiring_record",
      ),
    ).toEqual(expect.objectContaining({ status: "known", returned_count: 1 }));
    expect(calls).toContain(
      "POST https://shibaura.pita.services/career/get/employmentSub",
    );
    expect(calls).not.toContain(
      "POST https://shibaura.pita.services/career/get/companyExamSub",
    );
  });
});
