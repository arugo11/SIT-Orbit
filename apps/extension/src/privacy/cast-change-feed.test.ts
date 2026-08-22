import { describe, expect, it } from "vitest";
import {
  CareerVault,
  MemorySessionKeyStore,
  MemoryVaultStore,
} from "./career-vault";
import {
  CastChangeFeed,
  diffCastSnapshots,
  projectCastChangesForAgent,
} from "./cast-change-feed";

const PASSPHRASE = "change feed test passphrase";

async function createVault() {
  const store = new MemoryVaultStore();
  const vault = new CareerVault({
    store,
    sessionKeyStore: new MemorySessionKeyStore(),
  });
  await vault.create(PASSPHRASE);
  return { store, vault };
}

describe("CAST change feed", () => {
  it("reports only field-level changes and classifies useful CAST updates", () => {
    const changes = diffCastSnapshots(
      {
        opportunities: [
          {
            local_id: "internship:alpha",
            kind: "internship",
            application_deadline: "2026-09-01",
          },
        ],
        selection_reports: [],
      },
      {
        opportunities: [
          {
            local_id: "internship:alpha",
            kind: "internship",
            application_deadline: "2026-09-10",
          },
          {
            local_id: "internship:beta",
            kind: "internship",
            application_deadline: "2026-09-20",
          },
        ],
        selection_reports: [
          { local_id: "report:1", graduation_date: "2025-03-01" },
        ],
      },
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "changed",
          category: "deadline",
          summary: "締切が変更されました",
        }),
        expect.objectContaining({
          kind: "added",
          category: "internship",
          summary: "インターン情報が追加されました",
        }),
        expect.objectContaining({
          kind: "added",
          category: "history_report",
        }),
      ]),
    );
  });

  it("does not emit a change when the same keyed item is reordered", () => {
    const previous = [
      { local_id: "a", title: "A" },
      { local_id: "b", title: "B" },
    ];
    const current = [previous[1], previous[0]];
    expect(diffCastSnapshots(previous, current)).toEqual([]);
  });

  it("returns a baseline on first observation and persists snapshots encrypted", async () => {
    const { store, vault } = await createVault();
    const feed = new CastChangeFeed(vault);
    const baseline = await feed.compareAndStore(
      "cast-top-student",
      { notices: [{ title: "旧お知らせ" }] },
      "2026-08-22T00:00:00.000Z",
    );
    expect(baseline).toMatchObject({
      status: "baseline",
      previous_captured_at: null,
      changes: [],
    });
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain("旧お知らせ");
    expect(persisted).not.toContain("cast-top-student");
    expect(persisted).toContain("ciphertext");
  });

  it("compares a later snapshot and exposes only aggregate counts to an Agent", async () => {
    const { vault } = await createVault();
    const feed = new CastChangeFeed(vault);
    await feed.compareAndStore("cast-top-student", {
      opportunities: [
        { local_id: "job:1", application_deadline: "2026-08-30" },
      ],
      people: [{ name: "山田 太郎", source_identifier: "person-123" }],
    });
    const changeSet = await feed.compareAndStore("cast-top-student", {
      opportunities: [
        { local_id: "job:1", application_deadline: "2026-09-01" },
      ],
      people: [
        { name: "山田 太郎", source_identifier: "person-123" },
        { name: "佐藤 花子", source_identifier: "person-456" },
      ],
    });
    const projection = projectCastChangesForAgent(changeSet);
    expect(projection).toEqual({
      schema_version: "v1",
      status: "known",
      total_change_count: 2,
      added_count: 1,
      removed_count: 0,
      changed_count: 1,
      deadline_change_count: 1,
      internship_change_count: 0,
      history_report_change_count: 0,
      support_resource_change_count: 0,
      opportunity_change_count: 0,
    });
    expect(JSON.stringify(projection)).not.toContain("山田");
    expect(JSON.stringify(projection)).not.toContain("person-123");
    expect(JSON.stringify(projection)).not.toContain("2026-09-01");
  });

  it("rejects non-opaque source keys and over-sized snapshots", async () => {
    const { vault } = await createVault();
    const feed = new CastChangeFeed(vault);
    await expect(
      feed.compareAndStore("https://example.com/private", {}),
    ).rejects.toThrow("opaque");
    await expect(
      feed.compareAndStore("cast-top-student", "x".repeat(2_000_001)),
    ).rejects.toThrow("local change-feed limit");
  });

  it("returns no changes when a snapshot is recorded twice", async () => {
    const { vault } = await createVault();
    const feed = new CastChangeFeed(vault);
    const snapshot = { notices: [{ title: "同じお知らせ" }] };
    await feed.compareAndStore("cast-top-student", snapshot);
    const second = await feed.compareAndStore("cast-top-student", snapshot);
    expect(second.status).toBe("known");
    expect(second.changes).toEqual([]);
  });
});
