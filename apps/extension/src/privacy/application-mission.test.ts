import { describe, expect, it } from "vitest";
import {
  type ApplicationMissionRecord,
  ApplicationMissionStore,
  createApplicationMission,
  reduceApplicationMission,
} from "./application-mission";
import {
  CareerVault,
  MemorySessionKeyStore,
  MemoryVaultStore,
} from "./career-vault";

const PASSPHRASE = "local career vault passphrase";

function createVault() {
  const store = new MemoryVaultStore();
  const vault = new CareerVault({
    store,
    sessionKeyStore: new MemorySessionKeyStore(),
  });
  return { store, vault };
}

function mission(now = "2026-08-22T00:00:00.000Z") {
  return createApplicationMission(
    {
      target_local_id: "internship:toyosu-robotics-2026",
      target_kind: "internship",
      display_label: "合成ロボティクス株式会社 インターン",
    },
    now,
  );
}

function advanceToCalendar(
  record: ApplicationMissionRecord,
): ApplicationMissionRecord {
  let current = reduceApplicationMission(
    record,
    {
      type: "requirements-confirmed",
      deadline: "2026-09-01",
      required_documents: ["履歴書", "エントリーシート"],
      source_ref: "cast-opportunity:1",
    },
    "2026-08-22T00:01:00.000Z",
  );
  current = reduceApplicationMission(
    current,
    {
      type: "history-collected",
      source_refs: ["cast-history:1"],
    },
    "2026-08-22T00:02:00.000Z",
  );
  current = reduceApplicationMission(
    current,
    {
      type: "evidence-collected",
      evidence_ids: ["evidence:1"],
    },
    "2026-08-22T00:03:00.000Z",
  );
  current = reduceApplicationMission(
    current,
    {
      type: "es-drafted",
      draft_ref: "es-draft:1",
      review_refs: ["review:hr", "review:technical"],
    },
    "2026-08-22T00:04:00.000Z",
  );
  current = reduceApplicationMission(
    current,
    {
      type: "counseling-selected",
      resource_ref: "counseling:1",
    },
    "2026-08-22T00:05:00.000Z",
  );
  return current;
}

describe("application mission", () => {
  it("starts from a local CAST opportunity and keeps sensitive values out of the mission ID", () => {
    const record = mission();

    expect(record.mission_id).toMatch(/^application-mission:v1:[a-f0-9]{32}$/u);
    expect(record.current_step).toBe("requirements");
    expect(record.status).toBe("active");
    expect(record.target_local_id).toBe("internship:toyosu-robotics-2026");
    expect(record.mission_id).not.toContain("toyosu");
    expect(() =>
      createApplicationMission({
        target_local_id: "https://shibaura.pita.services/career/apply?id=1",
        target_kind: "job",
        display_label: "応募",
      }),
    ).toThrow("local CAST ID");
    expect(() =>
      createApplicationMission({
        target_local_id: "job:123456",
        target_kind: "job",
        display_label: "応募 al23088@sic.shibaura-it.ac.jp",
      }),
    ).toThrow("personal or URL");
  });

  it("requires the steps in order and preserves requirements details locally", () => {
    const record = mission();

    expect(() =>
      reduceApplicationMission(record, {
        type: "history-collected",
        source_refs: ["cast-history:1"],
      }),
    ).toThrow("must be history");

    const next = reduceApplicationMission(record, {
      type: "requirements-confirmed",
      deadline: "2026-09-01",
      required_documents: ["履歴書", "エントリーシート"],
      source_ref: "cast-opportunity:1",
    });
    expect(next.current_step).toBe("history");
    expect(next.requirements).toEqual({
      deadline: "2026-09-01",
      required_documents: ["履歴書", "エントリーシート"],
      source_ref: "cast-opportunity:1",
    });
    expect(next.steps.requirements.refs).toEqual([
      "cast-opportunity:1",
      "document:0",
      "document:1",
    ]);
    expect(next.transitions.at(-1)?.type).toBe("requirements-confirmed");
  });

  it("rejects invalid deadlines, URLs, and personal identifiers in mission events", () => {
    const record = mission();
    expect(() =>
      reduceApplicationMission(record, {
        type: "requirements-confirmed",
        deadline: "2026-02-30",
        required_documents: [],
        source_ref: "cast-opportunity:1",
      }),
    ).toThrow("deadline is invalid");
    expect(() =>
      reduceApplicationMission(record, {
        type: "requirements-confirmed",
        deadline: null,
        required_documents: ["https://example.invalid/file.pdf"],
        source_ref: "cast-opportunity:1",
      }),
    ).toThrow("personal or URL");
    expect(() =>
      reduceApplicationMission(record, {
        type: "requirements-confirmed",
        deadline: null,
        required_documents: [],
        source_ref: "mailto:student@example.invalid",
      }),
    ).toThrow("opaque local reference");
  });

  it("records a blocker and resumes only after an explicit unblock event", () => {
    const record = mission();
    const blocked = reduceApplicationMission(record, {
      type: "blocked",
      step: "requirements",
      reason: "締切と必要書類の確認が必要です",
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.steps.requirements.blocker).toBe(
      "締切と必要書類の確認が必要です",
    );
    expect(() =>
      reduceApplicationMission(blocked, {
        type: "requirements-confirmed",
        deadline: null,
        required_documents: [],
        source_ref: "cast-opportunity:1",
      }),
    ).toThrow("blocked");

    const resumed = reduceApplicationMission(blocked, { type: "unblocked" });
    expect(resumed.status).toBe("active");
    expect(resumed.current_step).toBe("requirements");
    expect(resumed.steps.requirements.blocker).toBeNull();
  });

  it("keeps calendar preview separate from the final confirmation", () => {
    const beforeCalendar = advanceToCalendar(mission());
    expect(beforeCalendar.current_step).toBe("calendar");

    const previewed = reduceApplicationMission(beforeCalendar, {
      type: "calendar-previewed",
      preview_ref: "calendar-preview:1",
    });
    expect(previewed.status).toBe("ready_for_confirmation");
    expect(previewed.steps.calendar.status).toBe("awaiting_confirmation");
    expect(previewed.calendar.confirmation_ref).toBeNull();
    expect(() =>
      reduceApplicationMission(beforeCalendar, {
        type: "calendar-confirmed",
        confirmation_ref: "calendar-confirmation:1",
      }),
    ).toThrow("pending preview");

    const completed = reduceApplicationMission(previewed, {
      type: "calendar-confirmed",
      confirmation_ref: "calendar-confirmation:1",
    });
    expect(completed.status).toBe("completed");
    expect(completed.current_step).toBe("completed");
    expect(completed.calendar).toEqual({
      preview_ref: "calendar-preview:1",
      confirmation_ref: "calendar-confirmation:1",
    });
  });

  it("stores mission records through the encrypted Career Vault and supports removal", async () => {
    const { store, vault } = createVault();
    await vault.create(PASSPHRASE);
    const missions = new ApplicationMissionStore(vault);
    const created = await missions.create({
      target_local_id: "job:toyosu-robotics-2026",
      target_kind: "job",
      display_label: "合成ロボティクス株式会社",
    });

    expect(await missions.get(created.mission_id)).toEqual(created);
    expect(await missions.list()).toHaveLength(1);
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain("合成ロボティクス株式会社");
    expect(persisted).not.toContain("toyosu-robotics-2026");
    expect(persisted).toContain("ciphertext");

    await missions.remove(created.mission_id);
    expect(await missions.list()).toEqual([]);
    await missions.clear();
    await vault.lock();
  });
});
