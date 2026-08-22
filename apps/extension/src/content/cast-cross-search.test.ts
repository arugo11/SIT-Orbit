import { describe, expect, it, vi } from "vitest";
import {
  buildCastCareerDocuments,
  type CastCareerSearchDocument,
  type CastSearchQuery,
  createCareerQueryPromptRequest,
  emptyCareerQuery,
  parseCareerQueryResponse,
  searchCastCareer,
  structureCareerQuery,
} from "./cast-cross-search";

const baseQuery = (
  overrides: Partial<CastSearchQuery> = {},
): CastSearchQuery => ({
  original: "機械系のプログラミング求人",
  terms: ["機械", "プログラミング"],
  required_terms: [],
  locations: [],
  technical_domains: [],
  occupations: [],
  kinds: [],
  year_from: null,
  year_to: null,
  obog_required: false,
  ...overrides,
});

const documents: CastCareerSearchDocument[] = [
  {
    id: "opportunity:job:alpha",
    kind: "job",
    title: "アルファロボティクス株式会社",
    text: "機械設計 制御ソフトウェア 組込み開発 豊洲 東京都",
    company: "アルファロボティクス株式会社",
    locations: ["東京都 豊洲"],
    technical_domains: ["機械工学", "プログラミング"],
    occupations: ["組込み開発"],
    years: [2026],
    deadline: "2026-09-30",
    source_url: null,
    local_payload: { local_only: true },
  },
  {
    id: "opportunity:internship:beta",
    kind: "internship",
    title: "ベータシステムズ株式会社",
    text: "Webアプリ開発 埼玉県 インターンシップ",
    company: "ベータシステムズ株式会社",
    locations: ["埼玉県"],
    technical_domains: ["情報工学"],
    occupations: ["ソフトウェア開発"],
    years: [2025],
    deadline: "2025-08-30",
    source_url: null,
    local_payload: { local_only: true },
  },
  {
    id: "history:report:alpha:0",
    kind: "selection_report",
    title: "アルファロボティクス株式会社 選考記録",
    text: "機械工学 組込み開発 OB・OG 選考フロー",
    company: "アルファロボティクス株式会社",
    locations: [],
    technical_domains: ["機械工学"],
    occupations: ["組込み開発"],
    years: [2024],
    deadline: null,
    source_url: null,
    local_payload: { local_only: true },
  },
];

describe("CAST cross search", () => {
  it("sends only the user's question to the local Prompt API", () => {
    const request = createCareerQueryPromptRequest(
      "豊洲から通いやすく、機械系とプログラミングを使う仕事を探して",
    );
    expect(request.prompt).toContain("豊洲から通いやすく");
    expect(request.prompt).not.toContain("local_payload");
    expect(request.prompt).not.toContain("アルファロボティクス");
    expect(request.response_constraint.additionalProperties).toBe(false);
  });

  it("normalizes and bounds a structured Prompt API response", () => {
    const query = parseCareerQueryResponse("機械系求人", {
      terms: ["機械", " 機械 ", "プログラミング", "x".repeat(200)],
      required_terms: ["機械"],
      locations: ["豊洲"],
      technical_domains: ["機械工学"],
      occupations: ["組込み開発"],
      kinds: ["job", "unknown"],
      year_from: 2024,
      year_to: 2026,
      obog_required: true,
      unexpected: "discarded",
    });
    expect(query).toEqual({
      original: "機械系求人",
      terms: ["機械", "プログラミング", "x".repeat(160)],
      required_terms: ["機械"],
      locations: ["豊洲"],
      technical_domains: ["機械工学"],
      occupations: ["組込み開発"],
      kinds: ["job"],
      year_from: 2024,
      year_to: 2026,
      obog_required: true,
    });
    expect(() => parseCareerQueryResponse("x", null)).toThrow();
  });

  it("uses the Chrome Prompt API without a remote fallback", async () => {
    const promptGlobal = globalThis as typeof globalThis & {
      LanguageModel?: {
        availability: () => Promise<string>;
        create: () => Promise<{
          prompt: () => Promise<string>;
          destroy: () => void;
        }>;
      };
    };
    const destroy = vi.fn();
    promptGlobal.LanguageModel = {
      availability: async () => "available",
      create: async () => ({
        prompt: async () =>
          JSON.stringify({
            terms: ["機械", "プログラミング"],
            required_terms: [],
            locations: ["豊洲"],
            technical_domains: ["機械工学"],
            occupations: [],
            kinds: ["job", "internship"],
            year_from: 2022,
            year_to: 2026,
            obog_required: true,
          }),
        destroy,
      }),
    };
    await expect(
      structureCareerQuery("豊洲の機械系求人"),
    ).resolves.toMatchObject({
      locations: ["豊洲"],
      kinds: ["job", "internship"],
      obog_required: true,
    });
    expect(destroy).toHaveBeenCalledOnce();
    delete promptGlobal.LanguageModel;
  });

  it("ranks exact, prefix, and fuzzy matches while applying strict filters", () => {
    const response = searchCastCareer(
      documents,
      baseQuery({
        locations: ["豊洲"],
        technical_domains: ["機械工学"],
        occupations: ["組込み"],
        kinds: ["job"],
        obog_required: false,
      }),
    );
    expect(response.searched_document_count).toBe(1);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.document.id).toBe("opportunity:job:alpha");
    expect(response.results[0]?.score).toBeGreaterThanOrEqual(0);
  });

  it("requires one recorded year to satisfy both ends of a year range", () => {
    const firstDocument = documents[0];
    if (!firstDocument) throw new Error("fixture document missing");
    const splitYears = {
      ...firstDocument,
      id: "history:split-years",
      kind: "hiring_record" as const,
      years: [2020, 2030],
    };
    const response = searchCastCareer(
      [splitYears],
      baseQuery({ terms: ["機械"], year_from: 2024, year_to: 2026 }),
    );
    expect(response.results).toHaveLength(0);
  });

  it("supports a cross-CAST query spanning opportunities and alumni reports", () => {
    const response = searchCastCareer(
      documents,
      baseQuery({
        terms: ["機械"],
        required_terms: ["機械"],
        obog_required: true,
      }),
      10,
    );
    expect(response.results.map((result) => result.document.kind)).toEqual([
      "selection_report",
    ]);
    expect(response.results[0]?.document.local_payload).toEqual({
      local_only: true,
    });
  });

  it("builds one local corpus from the three read-only CAST snapshots", () => {
    const documents = buildCastCareerDocuments({
      opportunities: [
        {
          schema_version: "v1",
          kind: "job",
          opportunities: [
            {
              kind: "job",
              local_id: "job:1",
              company_name: "合成企業",
              industry: ["機械"],
              status: "open",
              received_date: "2026-08-01",
              application_deadline: "2026-09-01",
              description: "組込み開発",
              occupations: ["設計"],
              locations: ["東京都"],
              eligible_programs: ["機械工学科"],
              target_grades: [],
              period_start: null,
              period_end: null,
              duration: [],
              application_methods: ["自由応募"],
              relations: {
                job_offer: true,
                company_session: false,
                internship: false,
                hiring_record: true,
                alumni_directory: true,
                career_supporter: true,
                entrance_exam: false,
              },
            },
          ],
        },
      ],
      histories: [
        {
          schema_version: "v1",
          company_name: "合成企業",
          company_code: "local-only",
          hiring_records: [],
          selection_reports: [],
          people: [],
          obog_available: true,
        },
      ],
      support: {
        schema_version: "v1",
        notices: [{ title: "説明会", published_date: "2026-08-02" }],
        resources: [
          {
            kind: "event",
            title: "講座動画",
            url: "https://shibaura-it.notion.site/example",
            published_date: "2026-08-03",
          },
        ],
        counseling_link_available: false,
        supporter_link_available: true,
      },
    });
    expect(documents.map((document) => document.kind)).toEqual([
      "job",
      "notice",
      "support_resource",
    ]);
    expect(
      documents.every(
        (document) =>
          document.source_url === null ||
          document.source_url.startsWith("https://"),
      ),
    ).toBe(true);
  });

  it("does not invent a result for an empty query", () => {
    const response = searchCastCareer(documents, emptyCareerQuery("すべて"));
    expect(response.results).toHaveLength(3);
    expect(response.total_matching).toBe(3);
  });
});
