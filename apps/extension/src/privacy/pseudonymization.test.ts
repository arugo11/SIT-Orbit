import { afterEach, describe, expect, it } from "vitest";
import {
  CareerVault,
  MemorySessionKeyStore,
  MemoryVaultStore,
} from "./career-vault";
import {
  type CastTypedSnapshot,
  ExternalPersonalDataError,
  PseudonymizationError,
  PseudonymizationGateway,
} from "./pseudonymization";

const PASSPHRASE = "local career vault passphrase";

function createFixture() {
  const store = new MemoryVaultStore();
  const vault = new CareerVault({
    store,
    sessionKeyStore: new MemorySessionKeyStore(),
  });
  return { store, vault };
}

async function createMission(missionId = "mission-2026-08") {
  const fixture = createFixture();
  await fixture.vault.create(PASSPHRASE);
  const gateway = new PseudonymizationGateway(fixture.vault);
  const mission = await gateway.startMission(missionId);
  return { ...fixture, gateway, mission };
}

const snapshot: CastTypedSnapshot = {
  schema_version: "v1",
  records: [
    {
      name: "山田 太郎",
      romanized_name: "Yamada Taro",
      source_identifier: "alumni-123",
      email: "taro@example.invalid",
      phone: "090-1234-5678",
      student_id: "AA123456",
      url: "https://shibaura.pita.services/career/alumni/123",
      file_name: "山田_選考記録.pdf",
      free_text: "山田 太郎が担当者へ連絡した。",
      role: "alumni",
      company: "サンプル技研",
      technical_domains: ["制御工学", "組込み"],
      job_types: ["研究開発"],
      location_area: "東京23区",
      graduation_year: 2022,
      evidence_id: "cast-report-v1-1",
    },
  ],
};

describe("CAST pseudonymization gateway", () => {
  const vaults: CareerVault[] = [];

  afterEach(async () => {
    await Promise.all(vaults.splice(0).map((vault) => vault.lock()));
  });

  it("stores the mapping only in the encrypted vault and emits a local alias", async () => {
    const { store, vault, mission } = await createMission();
    vaults.push(vault);

    const result = await mission.transform(snapshot, "local");
    const person = result.payload.people[0];
    expect(person?.alias).toMatch(/^先輩-[A-Z2-7]{8}$/u);
    expect(person).toEqual(
      expect.objectContaining({
        role: "alumni",
        company: "サンプル技研",
        graduation_year_bucket: "2020-2024",
      }),
    );
    expect(JSON.stringify(result.payload)).not.toContain("山田");
    expect(JSON.stringify(result.payload)).not.toContain(
      "taro@example.invalid",
    );
    expect(JSON.stringify(result.payload)).not.toContain("AA123456");
    expect(JSON.stringify(result.payload)).not.toContain("alumni-123");
    expect(result.manifest.replaced_person_count).toBe(1);
    expect(result.manifest.removed_fields).toEqual(
      expect.arrayContaining([
        "email",
        "phone",
        "student_id",
        "source_identifier",
        "free_text",
      ]),
    );
    expect(JSON.stringify(store.snapshot())).not.toContain("山田 太郎");
    expect(mission.id).toBe("mission-2026-08");
  });

  it("keeps the same alias for a person within a mission, including name order variants", async () => {
    const { vault, mission } = await createMission();
    vaults.push(vault);
    const first = await mission.transform(snapshot, "local");
    const second = await mission.transform(
      {
        schema_version: "v1",
        records: [
          {
            name: "太郎 山田",
            romanized_name: "Taro Yamada",
            source_identifier: "alumni-123",
            role: "alumni",
          },
        ],
      },
      "local",
    );
    expect(first.payload.people[0]?.alias).toBe(
      second.payload.people[0]?.alias,
    );
  });

  it("changes the external alias when the mission changes", async () => {
    const { vault, gateway } = await createMission("mission-a");
    vaults.push(vault);
    const first = await (await gateway.startMission("mission-a")).transform(
      snapshot,
      "local",
    );
    const second = await (await gateway.startMission("mission-b")).transform(
      snapshot,
      "local",
    );
    expect(first.payload.people[0]?.alias).not.toBe(
      second.payload.people[0]?.alias,
    );
  });

  it("does not allow personal CAST records to be sent to Azure", async () => {
    const { vault, mission } = await createMission();
    vaults.push(vault);
    await expect(mission.transform(snapshot, "azure")).rejects.toBeInstanceOf(
      ExternalPersonalDataError,
    );

    const publicOnly = await mission.transform(
      {
        schema_version: "v1",
        records: [],
        public_aggregates: [
          {
            category: "hiring_record",
            company: "公開企業",
            count: 8,
            year: 2024,
          },
        ],
      },
      "azure",
    );
    expect(publicOnly.payload.people).toEqual([]);
    expect(publicOnly.payload.public_aggregates).toEqual([
      {
        category: "hiring_record",
        company: "公開企業",
        count: 8,
        year_bucket: "2020-2024",
      },
    ]);
  });

  it("fails closed on URL credentials, query strings, tokens, and unknown schemas", async () => {
    const { vault, mission } = await createMission();
    vaults.push(vault);
    await expect(
      mission.transform({
        schema_version: "v1",
        records: [
          {
            name: "佐藤 花子",
            source_identifier: "session-token-abc",
            role: "unknown",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PseudonymizationError);
    await expect(
      mission.transform({
        schema_version: "v1",
        records: [
          {
            name: "佐藤 花子",
            url: "https://example.invalid/path?token=secret",
            role: "unknown",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PseudonymizationError);
    await expect(
      mission.transform({ schema_version: "v2", records: [] } as never),
    ).rejects.toThrow("Unsupported CAST snapshot schema");
  });
});
