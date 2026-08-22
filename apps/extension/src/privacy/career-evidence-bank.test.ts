import { describe, expect, it } from "vitest";
import {
  CareerEvidenceBank,
  projectCareerEvidenceForPrompt,
} from "./career-evidence-bank";
import {
  CareerVault,
  MemorySessionKeyStore,
  MemoryVaultStore,
} from "./career-vault";

const PASSPHRASE = "evidence bank test passphrase";

async function createBank() {
  const store = new MemoryVaultStore();
  const vault = new CareerVault({
    store,
    sessionKeyStore: new MemorySessionKeyStore(),
  });
  await vault.create(PASSPHRASE);
  return { store, vault, bank: new CareerEvidenceBank(vault) };
}

const draft = {
  claim: "曖昧な課題を整理できる",
  context: "PBLで要求仕様が不明確だった",
  action: "関係者3名にヒアリングして仕様を再定義した",
  result: "手戻りを減らした",
  source: "pbl" as const,
  person_ref: "person-local-7f2a",
  materials: [
    {
      kind: "document" as const,
      label: "振り返り記録",
      locator: "orbit-evidence://artifact/reflection-1",
    },
    {
      kind: "link" as const,
      label: "公開発表ページ",
      locator: "https://example.com/evidence?student=private#claim",
    },
  ],
};

describe("CareerEvidenceBank", () => {
  it("stores a draft in the encrypted Vault and keeps the evidence ID opaque", async () => {
    const { store, bank } = await createBank();
    const record = await bank.create(draft, "2026-08-22T00:00:00.000Z");
    expect(record).toMatchObject({
      schema_version: "v1",
      status: "draft",
      claim: "曖昧な課題を整理できる",
      person_ref: "person-local-7f2a",
    });
    expect(record.evidence_id).toMatch(/^career-evidence:v1:[a-f0-9]{32}$/u);
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain("曖昧な課題");
    expect(persisted).not.toContain("person-local-7f2a");
    expect(persisted).toContain("ciphertext");
  });

  it("only projects confirmed evidence and removes person refs and locators", async () => {
    const { bank } = await createBank();
    const draftRecord = await bank.create(draft);
    const confirmed = await bank.update(draftRecord.evidence_id, {
      status: "confirmed",
    });
    const projection = projectCareerEvidenceForPrompt([draftRecord, confirmed]);
    expect(projection).toEqual([
      {
        evidence_id: confirmed.evidence_id,
        claim: "曖昧な課題を整理できる",
        context: "PBLで要求仕様が不明確だった",
        action: "関係者3名にヒアリングして仕様を再定義した",
        result: "手戻りを減らした",
        source: "pbl",
        material_count: 2,
      },
    ]);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("person-local-7f2a");
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("student=private");
  });

  it("does not invent or alter quantitative claims", async () => {
    const { bank } = await createBank();
    const record = await bank.create({
      ...draft,
      result: "関係者3名へのヒアリング後、手戻りを2件減らした",
    });
    const updated = await bank.update(record.evidence_id, {
      status: "confirmed",
    });
    const projection = projectCareerEvidenceForPrompt([updated]);
    expect(projection[0]?.result).toBe(
      "関係者3名へのヒアリング後、手戻りを2件減らした",
    );
  });

  it("lists, updates, removes, and clears evidence records", async () => {
    const { bank } = await createBank();
    const first = await bank.create(draft);
    const second = await bank.create({
      ...draft,
      claim: "再現可能な実験を設計できる",
    });
    expect((await bank.list()).map((record) => record.evidence_id)).toEqual([
      first.evidence_id,
      second.evidence_id,
    ]);
    await bank.remove(first.evidence_id);
    expect(await bank.get(first.evidence_id)).toBeNull();
    expect((await bank.list()).map((record) => record.evidence_id)).toEqual([
      second.evidence_id,
    ]);
    await bank.clear();
    expect(await bank.list()).toEqual([]);
  });

  it("normalizes public material URLs and rejects unsafe identifiers", async () => {
    const { bank } = await createBank();
    const record = await bank.create({
      ...draft,
      person_ref: "person-ABC_123",
      materials: [
        {
          kind: "link",
          label: "公開資料",
          locator: "https://example.com/path?token=private#fragment",
        },
      ],
    });
    expect(record.materials?.[0]?.locator).toBe("https://example.com/path");
    await expect(
      bank.create({ ...draft, person_ref: "山田 太郎" }),
    ).rejects.toThrow("opaque");
    await expect(
      bank.create({
        ...draft,
        materials: [
          { kind: "link", label: "unsafe", locator: "javascript:alert(1)" },
        ],
      }),
    ).rejects.toThrow("HTTP");
  });

  it("does not accept empty evidence fields", async () => {
    const { bank } = await createBank();
    await expect(bank.create({ ...draft, claim: "   " })).rejects.toThrow(
      "claim",
    );
    await expect(
      bank.create({ ...draft, source: "unknown" as never }),
    ).rejects.toThrow("source");
    await expect(
      bank.create({ ...draft, status: "published" as never }),
    ).rejects.toThrow("status");
    await expect(
      bank.create({ ...draft, result: "x".repeat(4001) }),
    ).rejects.toThrow("maximum length");
    await expect(
      bank.create({
        ...draft,
        materials: Array.from({ length: 13 }, (_, index) => ({
          kind: "artifact" as const,
          label: `artifact-${index}`,
          locator: `orbit-evidence://artifact/${index}`,
        })),
      }),
    ).rejects.toThrow("Too many");
  });
});
