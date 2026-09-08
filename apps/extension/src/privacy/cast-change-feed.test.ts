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
      {
        schema_version: "v1",
        records: [
          {
            reference: "notice:synthetic-1",
            category: "support_resource",
            published_date: "2026-08-01",
          },
        ],
        counts: { notices: 1 },
      },
      "2026-08-22T00:00:00.000Z",
    );
    expect(baseline).toMatchObject({
      status: "baseline",
      previous_captured_at: null,
      changes: [],
    });
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain("synthetic-1");
    expect(persisted).not.toContain("cast-top-student");
    expect(persisted).toContain("ciphertext");
    await expect(feed.read("cast-top-student")).resolves.toMatchObject({
      snapshot: {
        schema_version: "v1",
        records: [
          {
            reference: "notice:synthetic-1",
            category: "support_resource",
            published_date: "2026-08-01",
          },
        ],
      },
    });
  });

  it("compares a later snapshot and exposes only aggregate counts to an Agent", async () => {
    const { vault } = await createVault();
    const feed = new CastChangeFeed(vault);
    await feed.compareAndStore("cast-top-student", {
      schema_version: "v1",
      records: [
        {
          reference: "opportunity:job-1",
          category: "opportunity",
          kind: "job",
          deadline: "2026-08-30",
        },
      ],
      counts: { people: 1 },
    });
    const changeSet = await feed.compareAndStore("cast-top-student", {
      schema_version: "v1",
      records: [
        {
          reference: "opportunity:job-1",
          category: "opportunity",
          kind: "job",
          deadline: "2026-09-01",
        },
        {
          reference: "opportunity:job-2",
          category: "opportunity",
          kind: "job",
          deadline: "2026-09-20",
        },
      ],
      counts: { people: 1 },
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
      opportunity_change_count: 1,
    });
    expect(JSON.stringify(projection)).not.toContain("opportunity:job");
    expect(JSON.stringify(projection)).not.toContain("2026-09-01");
  });

  it("rejects non-opaque source keys, unsafe snapshots, and over-sized snapshots", async () => {
    const { store, vault } = await createVault();
    const feed = new CastChangeFeed(vault);
    const recordsBeforeInvalidInputs = store.snapshot().records.length;
    await expect(
      feed.compareAndStore("https://example.com/private", {}),
    ).rejects.toThrow("opaque");
    await expect(
      feed.compareAndStore("cast-top-student", {
        schema_version: "v1",
        records: [
          {
            reference: "notice:unsafe-1",
            category: "support_resource",
            title: "raw page text",
          },
        ],
        counts: { notices: 1 },
      }),
    ).rejects.toThrow("unsupported field");
    await expect(
      feed.compareAndStore("cast-top-student", {
        schema_version: "v1",
        records: [
          {
            reference: "notice:unsafe-1",
            category: "support_resource",
            count: 1,
          },
        ],
        counts: { notices: 1 },
        raw_html: "<html>private</html>",
      }),
    ).rejects.toThrow("unsupported field");
    await expect(
      feed.compareAndStore("cast-top-student", {
        schema_version: "v1",
        records: [
          {
            reference: "notice:unsafe?query",
            category: "support_resource",
            count: 1,
          },
        ],
        counts: { notices: 1 },
      }),
    ).rejects.toThrow("opaque");
    await expect(
      feed.compareAndStore("cast-top-student", {
        schema_version: "v1",
        records: [
          {
            reference: "notice:duplicate-1",
            category: "support_resource",
          },
          {
            reference: "notice:duplicate-1",
            category: "support_resource",
          },
        ],
        counts: { notices: 2 },
      }),
    ).rejects.toThrow("unique");
    await expect(
      feed.compareAndStore("cast-top-student", "x".repeat(2_000_001)),
    ).rejects.toThrow("local change-feed limit");
    expect(store.snapshot().records).toHaveLength(recordsBeforeInvalidInputs);
  });

  it("returns no changes when a snapshot is recorded twice", async () => {
    const { vault } = await createVault();
    const feed = new CastChangeFeed(vault);
    const snapshot = {
      schema_version: "v1" as const,
      records: [
        {
          reference: "notice:synthetic-2",
          category: "support_resource" as const,
          published_date: "2026-08-02",
        },
      ],
      counts: { notices: 1 },
    };
    await feed.compareAndStore("cast-top-student", snapshot);
    const second = await feed.compareAndStore("cast-top-student", snapshot);
    expect(second.status).toBe("known");
    expect(second.changes).toEqual([]);
  });

  it("rejects an unsafe snapshot already present in the encrypted Vault", async () => {
    const { vault } = await createVault();
    const feed = new CastChangeFeed(vault);
    const digest = await vault.hmac("cast-change-snapshot:v1:cast-top-student");
    const recordId = `cast-change-snapshot:v1:${Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
    await vault.put(recordId, {
      schema_version: "v1",
      captured_at: "2026-08-22T00:00:00.000Z",
      snapshot: {
        schema_version: "v1",
        records: [
          {
            reference: "notice:unsafe-2",
            category: "support_resource",
            token: "secret",
          },
        ],
        counts: { notices: 1 },
      },
    });
    await expect(feed.read("cast-top-student")).rejects.toThrow(
      "unsupported field",
    );
  });
});
