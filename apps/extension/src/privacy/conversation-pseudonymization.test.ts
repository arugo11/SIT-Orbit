import { describe, expect, it } from "vitest";
import {
  ConversationPseudonymizationGateway,
  isProviderSafeConversationText,
  MemoryConversationAliasStore,
  MemoryConversationSessionKeyStore,
} from "./conversation-pseudonymization";

const person = {
  display_name: "山田 太郎",
  romanized_name: "Yamada Taro",
  source_identifier: "alumni-123",
  email: "taro@example.invalid",
  phone: "090-1234-5678",
  student_id: "AA123456",
  role: "alumni",
  company: "サンプル技研",
  technical_domains: ["自然言語処理"],
  job_types: ["研究開発"],
  location_area: "東京23区",
  graduation_year: 2022,
  evidence_id: "cast-report-v1-1",
};

function createGateway(options: { now?: () => number; ttlMs?: number } = {}) {
  return {
    store: new MemoryConversationAliasStore(),
    gateway: new ConversationPseudonymizationGateway({
      store: new MemoryConversationAliasStore(),
      keyStore: new MemoryConversationSessionKeyStore(),
      ...options,
    }),
  };
}

describe("conversation pseudonymization gateway", () => {
  it("keeps aliases stable within a conversation and isolates a new chat", async () => {
    const { gateway } = createGateway();
    const first = await gateway.transformText(
      "conversation-a",
      "山田 太郎へ連絡する。taro@example.invalid AA123456",
      [person],
    );
    const second = await gateway.transformText(
      "conversation-a",
      "Yamada Taroの資料を確認する。",
      [person],
    );
    const other = await gateway.transformText(
      "conversation-b",
      "山田 太郎の資料を確認する。",
      [person],
    );
    expect(first.provider_content).not.toContain("山田");
    expect(first.provider_content).not.toContain("taro@example.invalid");
    expect(first.provider_content).not.toContain("AA123456");
    expect(first.display_content).toContain("山田 太郎");
    expect(second.provider_content).toContain(
      first.provider_content.match(/\[\[ORBIT_PERSON_[^\]]+\]\]/u)?.[0] ??
        "[[ORBIT_PERSON_",
    );
    expect(other.provider_content).not.toBe(second.provider_content);
    expect(isProviderSafeConversationText(first.provider_content)).toBe(true);
  });

  it("reuses known aliases when a follow-up has no typed people payload", async () => {
    const { gateway } = createGateway();
    const first = await gateway.transformText(
      "conversation-follow-up",
      "山田 太郎のプロフィールを確認する。",
      [person],
    );
    const token = first.provider_content.match(
      /\[\[ORBIT_PERSON_[^\]]+\]\]/u,
    )?.[0];
    if (!token) throw new Error("alias token was not generated");
    const followUp = await gateway.transformText(
      "conversation-follow-up",
      "山田 太郎について、もう少し詳しく。",
    );
    expect(followUp.provider_content).toContain(token);
    expect(followUp.provider_content).not.toContain("山田 太郎");
  });

  it("stores only encrypted mapping records and emits typed CAST projections", async () => {
    const store = new MemoryConversationAliasStore();
    const gateway = new ConversationPseudonymizationGateway({
      store,
      keyStore: new MemoryConversationSessionKeyStore(),
    });
    const result = await gateway.transformTurn({
      conversationId: "conversation-cast",
      content: "担当者を確認したい。",
      people: [person],
      evidence: [
        {
          evidence_id: "cast-report-v1-1",
          title: "山田 太郎の記録",
          source_type: "cast",
          locator: "orbit-cast://evidence/cast-report-v1-1",
          data_classification: "restricted",
        },
      ],
    });
    expect(result.provider.people[0]).toEqual(
      expect.objectContaining({
        role: "alumni",
        company: "サンプル技研",
        graduation_year_bucket: "2020-2024",
      }),
    );
    expect(JSON.stringify(result.provider)).not.toContain("山田");
    expect(JSON.stringify(result.provider)).not.toContain("AA123456");
    expect(JSON.stringify(store.snapshot())).not.toContain("山田");
    expect(JSON.stringify(store.snapshot())).not.toContain("サンプル技研");
  });

  it("sanitizes a Tool projection at the provider boundary", async () => {
    const gateway = new ConversationPseudonymizationGateway({
      store: new MemoryConversationAliasStore(),
      keyStore: new MemoryConversationSessionKeyStore(),
    });
    const typed = await gateway.transformTypedPeople("conversation-tool", [
      person,
    ]);
    const alias = typed.provider_people[0]?.alias;
    if (!alias) throw new Error("alias was not generated");
    const transformed = await gateway.transformToolProjection(
      "conversation-tool",
      {
        schema_version: "v1",
        status: "known",
        course_ref: "orbit-scombz://course/opaque-course-ref",
        title: "山田 太郎の課題",
        body: "連絡先 taro@example.invalid AA123456",
        raw_html: "<html><body>do not send</body></html>",
        private_token: "secret-token",
        future_metadata: "must not cross boundary",
        text: "data:application/pdf;base64,JVBERi0xLjQ=",
        url: "https://example.invalid/material?token=secret#page=2",
      },
    );
    const provider = transformed.provider_result as Record<string, unknown>;
    expect(provider.title).toBe(`${alias}の課題`);
    expect(provider.body).not.toContain("taro@example.invalid");
    expect(provider.body).not.toContain("AA123456");
    expect(provider.raw_html).toBeUndefined();
    expect(provider.private_token).toBeUndefined();
    expect(provider.future_metadata).toBeUndefined();
    expect(provider.text).toBe("[内容は省略]");
    expect(provider.url).toBe("https://example.invalid/material");
    expect(transformed.report.removed_fields).toEqual(
      expect.arrayContaining(["raw_html", "private_token"]),
    );
    expect(JSON.stringify(provider)).not.toMatch(
      /taro@example.invalid|AA123456|secret-token|JVBERi0|<html>/u,
    );
  });

  it("reloads aliases minted by the other extension context", async () => {
    const store = new MemoryConversationAliasStore();
    const keyStore = new MemoryConversationSessionKeyStore();
    const sidePanel = new ConversationPseudonymizationGateway({
      store,
      keyStore,
    });
    const serviceWorker = new ConversationPseudonymizationGateway({
      store,
      keyStore,
    });
    await sidePanel.transformText("conversation-shared", "資料を確認する。");
    const typed = await serviceWorker.transformTypedPeople(
      "conversation-shared",
      [person],
    );
    const token = typed.provider_people[0]?.alias;
    if (!token) throw new Error("shared alias was not generated");
    const restored = await sidePanel.restoreMarkdown(
      "conversation-shared",
      `担当者: ${token}`,
    );
    expect(restored.content).toContain("山田 太郎");
    expect(restored.warnings).toHaveLength(0);
  });

  it("restores only normal Markdown text and warns for unknown tokens", async () => {
    const { gateway } = createGateway();
    const transformed = await gateway.transformText(
      "conversation-md",
      "山田 太郎",
      [person],
    );
    const token = transformed.provider_content.match(
      /\[\[ORBIT_PERSON_[^\]]+\]\]/u,
    )?.[0];
    if (!token) throw new Error("alias token was not generated");
    const tick = String.fromCharCode(96);
    const restored = await gateway.restoreMarkdown(
      "conversation-md",
      token +
        " " +
        tick +
        token +
        tick +
        " orbit-cast://alumni/opaque [link](https://example.invalid/?token=secret) [[ORBIT_PERSON_unknown]]",
    );
    expect(restored.content).toContain("山田 太郎");
    expect(restored.content).toContain(tick + token + tick);
    expect(restored.content).toContain("https://example.invalid/?token=secret");
    expect(restored.content).toContain("orbit-cast://alumni/opaque");
    expect(restored.warnings).toHaveLength(1);
  });

  it("warns for malformed alias tokens outside protected Markdown", async () => {
    const { gateway } = createGateway();
    const restored = await gateway.restoreMarkdown(
      "conversation-malformed-token",
      "本文 [[ORBIT_PERSON_bad!]] と `[[ORBIT_PERSON_bad!]]`",
    );
    expect(restored.content).toContain("[[ORBIT_PERSON_bad!]]");
    expect(restored.warnings).toEqual([
      "未知または変形された仮名トークンは復元しませんでした。",
    ]);
  });

  it("drops non-opaque evidence identifiers and query-bearing locators", async () => {
    const { gateway } = createGateway();
    const result = await gateway.transformEvidence("conversation-evidence", [
      {
        evidence_id: "safe-evidence-1",
        title: "資料",
        source_type: "scombz",
        locator: "orbit-scombz://citation/safe-evidence-1",
        data_classification: "personal",
      },
      {
        evidence_id: "https://example.invalid/private?id=1",
        title: "連絡先 student@example.invalid",
        source_type: "scombz",
        locator: "https://example.invalid/private?id=1",
        data_classification: "personal",
      },
      {
        evidence_id: "safe-evidence-2",
        title: "壊れた参照先",
        source_type: "scombz",
        locator: "orbit-scombz://citation/item?token=secret",
        data_classification: "personal",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        evidence_id: "safe-evidence-1",
        locator: "orbit-scombz://citation/safe-evidence-1",
      }),
    );
  });

  it("does not classify internal SCombZ identifiers or query-bearing URLs as safe", () => {
    expect(
      isProviderSafeConversationText("202601SU0176271001 は安全ではない"),
    ).toBe(false);
    expect(
      isProviderSafeConversationText(
        "https://scombz.shibaura-it.ac.jp/lms/course?idnumber=secret",
      ),
    ).toBe(false);
  });

  it("expires mappings and clears unrecoverable records when the session key is gone", async () => {
    let now = 0;
    const store = new MemoryConversationAliasStore();
    const keyStore = new MemoryConversationSessionKeyStore();
    const gateway = new ConversationPseudonymizationGateway({
      store,
      keyStore,
      ttlMs: 10,
      now: () => now,
    });
    const first = await gateway.transformText("conversation-ttl", "山田 太郎", [
      person,
    ]);
    now = 20;
    const second = await gateway.transformText(
      "conversation-ttl",
      "山田 太郎",
      [person],
    );
    expect(second.provider_content).not.toBe(first.provider_content);
    await keyStore.clear();
    await gateway.begin("conversation-after-restart");
    expect(store.snapshot()).toHaveLength(1);
  });
});
