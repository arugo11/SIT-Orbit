import { afterEach, describe, expect, it, vi } from "vitest";
import type { CastHistoryLocalSnapshot } from "../content/cast-history-reports-reader";
import type { CastSupportLocalSnapshot } from "../content/cast-support-resources-reader";
import {
  CareerVault,
  MemorySessionKeyStore,
  MemoryVaultStore,
} from "./career-vault";
import {
  buildObogCandidateProjections,
  createObogConciergePromptRequest,
  OBOG_CONCIERGE_RESPONSE_CONSTRAINT,
  type ObogConciergeInput,
  ObogMeetingMemoStore,
  parseObogConciergeResponse,
  planObogConcierge,
  projectObogSupportResources,
} from "./obog-concierge";
import { PseudonymizationGateway } from "./pseudonymization";

const PASSPHRASE = "local career vault passphrase";

function createVault() {
  const store = new MemoryVaultStore();
  const vault = new CareerVault({
    store,
    sessionKeyStore: new MemorySessionKeyStore(),
  });
  return { store, vault };
}

const history: CastHistoryLocalSnapshot = {
  schema_version: "v1",
  company_name: "合成精密株式会社",
  company_code: "9500711",
  hiring_records: [],
  selection_reports: [],
  people: [
    {
      name: "山田 太郎",
      source_identifier: "alumni-123",
      role: "alumni",
      graduation_year: 2024,
      company: "合成精密株式会社",
      technical_domains: ["制御工学"],
      job_types: ["研究開発"],
    },
  ],
  obog_available: true,
};

const support: CastSupportLocalSnapshot = {
  schema_version: "v1",
  notices: [],
  resources: [
    {
      kind: "supporter",
      title: "キャリアサポート課 スタッフ紹介ページ",
      url: "https://shibaura-it.notion.site/example",
      published_date: null,
    },
  ],
  counseling_link_available: true,
  supporter_link_available: true,
};

const fixedCandidate = {
  alias: "先輩-ABCDEFGH",
  role: "alumni" as const,
  company: "合成精密株式会社",
  technical_domains: ["制御工学"],
  job_types: ["研究開発"],
  graduation_year_bucket: "2020-2024",
};

const input: ObogConciergeInput = {
  objective: "制御工学を使う研究開発職の仕事内容と選考準備を確認したい",
  candidates: [fixedCandidate],
  resources: [
    {
      resource_id: "support-resource:0",
      kind: "supporter",
      title: "キャリアサポート課 スタッフ紹介ページ",
      published_date: null,
    },
  ],
  forbidden_local_terms: ["山田 太郎"],
};

function validPlan() {
  return {
    schema_version: "v1",
    selected_candidate_alias: fixedCandidate.alias,
    purpose: "研究開発職の実務と選考準備を確認する",
    questions: [
      {
        priority: "must",
        question:
          "研究開発職で最初に任された仕事と、必要だった準備を教えてください。",
      },
    ],
    request_draft: {
      subject: "就活サポーター面談の依頼",
      body: "キャリアサポート課を通じて、研究開発職について面談をお願いしたいです。",
    },
    pre_meeting_brief: [
      {
        text: "候補は制御工学と研究開発職に関する表示があります。",
        references: [fixedCandidate.alias],
      },
      {
        text: "キャリアサポート課のスタッフ紹介ページを確認できます。",
        references: ["support-resource:0"],
      },
    ],
    follow_up_draft:
      "本日は研究開発職について具体的に教えていただき、ありがとうございました。",
  };
}

describe("OBOG concierge", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { LanguageModel?: unknown })
      .LanguageModel;
    vi.restoreAllMocks();
  });

  it("creates mission-scoped aliases without putting original names in the projection", async () => {
    const { vault } = createVault();
    await vault.create(PASSPHRASE);
    const gateway = new PseudonymizationGateway(vault);
    const firstMission = await gateway.startMission("obog-a");
    const secondMission = await gateway.startMission("obog-b");
    const first = await buildObogCandidateProjections(history, firstMission);
    const repeated = await buildObogCandidateProjections(history, firstMission);
    const second = await buildObogCandidateProjections(history, secondMission);

    expect(first[0]?.alias).toMatch(/^先輩-[A-Z2-7]{8}$/u);
    expect(first[0]?.alias).toBe(repeated[0]?.alias);
    expect(first[0]?.alias).not.toBe(second[0]?.alias);
    expect(JSON.stringify(first)).not.toContain("山田");
    await vault.lock();
  });

  it("keeps the prompt local and omits direct URLs, names, and identifiers", () => {
    const request = createObogConciergePromptRequest(input);
    expect(request.prompt).toContain(fixedCandidate.alias);
    expect(request.prompt).toContain("support-resource:0");
    expect(request.prompt).not.toContain("山田 太郎");
    expect(request.prompt).not.toContain("https://");
    expect(request.prompt).not.toContain("source_identifier");
    expect(request.responseConstraint).toEqual(
      OBOG_CONCIERGE_RESPONSE_CONSTRAINT,
    );
  });

  it("validates references and rejects direct contact, unknown aliases, and score fields", () => {
    expect(parseObogConciergeResponse(validPlan(), input)).toMatchObject({
      selected_candidate_alias: fixedCandidate.alias,
      request_draft: expect.objectContaining({ subject: expect.any(String) }),
    });

    expect(() =>
      parseObogConciergeResponse({ ...validPlan(), score: 87 }, input),
    ).toThrow("unsupported field");
    expect(() =>
      parseObogConciergeResponse(
        {
          ...validPlan(),
          selected_candidate_alias: "先輩-23456777",
        },
        input,
      ),
    ).toThrow("unknown candidate");
    expect(() =>
      parseObogConciergeResponse(
        {
          ...validPlan(),
          request_draft: {
            subject: "依頼",
            body: "mailto:alumni@example.invalid に直接連絡してください。",
          },
        },
        input,
      ),
    ).toThrow("contact or credential");
    expect(() =>
      parseObogConciergeResponse(
        {
          ...validPlan(),
          pre_meeting_brief: [
            { text: "不明な参照", references: ["support-resource:9"] },
          ],
        },
        input,
      ),
    ).toThrow("Unknown OBOG resource");
    expect(() =>
      parseObogConciergeResponse(
        {
          ...validPlan(),
          follow_up_draft: "山田太郎さんへ連絡しました。",
        },
        input,
      ),
    ).toThrow("local-only person name");
  });

  it("generates one structured local plan without contacting a provider", async () => {
    const prompts: string[] = [];
    const destroy = vi.fn();
    (
      globalThis as typeof globalThis & { LanguageModel?: unknown }
    ).LanguageModel = {
      availability: async () => "available",
      create: async () => ({
        prompt: async (value: string) => {
          prompts.push(value);
          return JSON.stringify(validPlan());
        },
        destroy,
      }),
    };
    const plan = await planObogConcierge(input);
    expect(plan.selected_candidate_alias).toBe(fixedCandidate.alias);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("山田 太郎");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("stores meeting notes only as encrypted Career Vault records", async () => {
    const { store, vault } = createVault();
    await vault.create(PASSPHRASE);
    const memos = new ObogMeetingMemoStore(vault);
    const saved = await memos.save({
      candidate_alias: fixedCandidate.alias,
      purpose: "研究開発職の面談",
      notes: ["制御系の配属例を確認した"],
      insights: ["面接では設計判断の説明が必要"],
      next_steps: ["求人票の締切を確認する"],
    });
    expect(saved.memo_id).toMatch(/^obog-concierge-memo:v1:[a-f0-9]{32}$/u);
    expect(await memos.list()).toEqual([saved]);
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain("制御系の配属例");
    expect(persisted).not.toContain("研究開発職の面談");
    await memos.clear();
    expect(await memos.list()).toEqual([]);
    await vault.lock();
  });

  it("keeps concurrent meeting memos indexed across store instances", async () => {
    const { vault } = createVault();
    await vault.create(PASSPHRASE);
    const firstStore = new ObogMeetingMemoStore(vault);
    const secondStore = new ObogMeetingMemoStore(vault);

    const [first, second] = await Promise.all([
      firstStore.save({
        candidate_alias: fixedCandidate.alias,
        purpose: "研究開発職の面談",
        notes: ["制御系の配属例を確認した"],
        insights: ["面接では設計判断の説明が必要"],
        next_steps: ["求人票の締切を確認する"],
      }),
      secondStore.save({
        candidate_alias: fixedCandidate.alias,
        purpose: "研究開発職の準備",
        notes: ["研究内容の説明を整理した"],
        insights: ["質問を事前に用意する"],
        next_steps: ["面談候補日を確認する"],
      }),
    ]);

    expect((await firstStore.list()).map((record) => record.memo_id)).toEqual([
      first.memo_id,
      second.memo_id,
    ]);
    await vault.lock();
  });
});

describe("OBOG support resource projection", () => {
  it("keeps local titles while assigning opaque local resource references", () => {
    const projected = projectObogSupportResources(support);
    expect(projected).toEqual([
      {
        resource_id: "support-resource:0",
        kind: "supporter",
        title: "キャリアサポート課 スタッフ紹介ページ",
        published_date: null,
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("https://");
  });
});
