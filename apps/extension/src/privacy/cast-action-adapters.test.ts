import { describe, expect, it, vi } from "vitest";
import {
  CastActionAdapter,
  type CastActionExecutor,
  createCastActionExecutionRef,
} from "./cast-action-adapters";

const missionId = "application-mission:v1:0123456789abcdef0123456789abcdef";

const applicationInput = {
  kind: "cast_application" as const,
  mission_id: missionId,
  target_ref: "internship:toyosu-robotics-2026",
  display_label: "合成ロボティクス株式会社 インターン",
  deadline: "2026-09-01",
  required_documents: ["履歴書", "エントリーシート"],
  is_recommendation: false,
};

function executorFixture() {
  const execute = vi.fn(async () => ({
    status: "executed" as const,
    execution_ref: createCastActionExecutionRef(),
  }));
  const executor: CastActionExecutor = { execute };
  return { execute, executor };
}

describe("CAST action adapters", () => {
  it("creates a local preview without a write executor or URL", () => {
    const adapter = new CastActionAdapter();
    const preview = adapter.preview(applicationInput);

    expect(preview.preview_id).toMatch(
      /^cast-action-preview:v1:[a-f0-9]{32}$/u,
    );
    expect(preview.confirmation_tier).toBe("standard");
    expect(preview.status).toBe("pending_confirmation");
    expect(preview.summary).toEqual({
      kind: "cast_application",
      deadline: "2026-09-01",
      required_documents: ["履歴書", "エントリーシート"],
      required_document_count: 2,
      is_recommendation: false,
    });
    expect(JSON.stringify(preview)).not.toContain("https://");
    expect(adapter.get(preview.preview_id)?.status).toBe(
      "pending_confirmation",
    );
  });

  it("never calls an executor before explicit confirmation", async () => {
    const { execute, executor } = executorFixture();
    const adapter = new CastActionAdapter(executor);
    const preview = adapter.preview(applicationInput);

    expect(await adapter.execute(preview.preview_id)).toEqual({
      status: "blocked",
      reason_code: "explicit_confirmation_required",
    });
    expect(execute).not.toHaveBeenCalled();

    const confirmed = adapter.confirm(preview.preview_id, {
      phase: "primary",
      phrase: "実行を確認",
    });
    expect(confirmed.status).toBe("confirmed");
    expect(await adapter.execute(preview.preview_id)).toMatchObject({
      status: "executed",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(adapter.get(preview.preview_id)?.status).toBe("executed");
  });

  it("requires two confirmations for a recommendation application", async () => {
    const { execute, executor } = executorFixture();
    const adapter = new CastActionAdapter(executor);
    const preview = adapter.preview({
      ...applicationInput,
      is_recommendation: true,
    });

    expect(preview.confirmation_tier).toBe("red");
    expect(() =>
      adapter.confirm(preview.preview_id, {
        phase: "red",
        phrase: "推薦応募を実行する",
      }),
    ).toThrow("Primary confirmation");
    expect(
      adapter.confirm(preview.preview_id, {
        phase: "primary",
        phrase: "実行を確認",
      }).status,
    ).toBe("awaiting_red_confirmation");
    expect(await adapter.execute(preview.preview_id)).toEqual({
      status: "blocked",
      reason_code: "explicit_confirmation_required",
    });
    expect(execute).not.toHaveBeenCalled();

    const confirmed = adapter.confirm(preview.preview_id, {
      phase: "red",
      phrase: "推薦応募を実行する",
    });
    expect(confirmed.status).toBe("confirmed");
    await adapter.execute(preview.preview_id);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("previews counseling, attachment metadata, and calendar without file bytes or tokens", () => {
    const adapter = new CastActionAdapter();
    const counseling = adapter.preview({
      kind: "cast_counseling_request",
      mission_id: missionId,
      target_ref: "counseling:career-support-1",
      display_label: "キャリア相談枠",
      slot_start: "2026-09-02T09:00:00+09:00",
      slot_end: "2026-09-02T09:30:00+09:00",
      purpose: "研究開発職の選考準備を相談する",
    });
    const attachment = adapter.preview({
      kind: "cast_attachment",
      mission_id: missionId,
      target_ref: "internship:toyosu-robotics-2026",
      display_label: "ES添付",
      attachment_ref: "attachment:es-draft-1",
      file_name: "es-draft.pdf",
      mime_type: "application/pdf",
    });
    const calendar = adapter.preview({
      kind: "calendar_event",
      mission_id: missionId,
      target_ref: "calendar:application-deadline",
      display_label: "応募締切の確認",
      title: "応募締切",
      start: "2026-09-01T09:00:00+09:00",
      end: "2026-09-01T09:30:00+09:00",
      time_zone: "Asia/Tokyo",
      source_ref: "cast-opportunity:1",
    });

    expect(counseling.summary.kind).toBe("cast_counseling_request");
    expect(attachment.summary).toMatchObject({
      kind: "cast_attachment",
      attachment_ref: "attachment:es-draft-1",
      file_name: "es-draft.pdf",
    });
    expect(calendar.summary).toMatchObject({
      kind: "calendar_event",
      source_ref: "cast-opportunity:1",
    });
    expect(JSON.stringify({ counseling, attachment, calendar })).not.toContain(
      "token",
    );
  });

  it("rejects unknown targets, URLs, credentials, invalid dates, and file paths", () => {
    const adapter = new CastActionAdapter();
    expect(() =>
      adapter.preview({
        ...applicationInput,
        target_ref: "company:unknown",
      }),
    ).toThrow("opaque local reference");
    expect(() =>
      adapter.preview({
        ...applicationInput,
        display_label: "応募 https://example.invalid",
      }),
    ).toThrow("personal or credential");
    expect(() =>
      adapter.preview({
        ...applicationInput,
        deadline: "2026-02-30",
      }),
    ).toThrow("date is invalid");
    expect(() =>
      adapter.preview({
        kind: "cast_attachment",
        mission_id: missionId,
        target_ref: "internship:toyosu-robotics-2026",
        display_label: "添付",
        attachment_ref: "attachment:1",
        file_name: "../secret.pdf",
        mime_type: "application/pdf",
      }),
    ).toThrow("local PDF");
    expect(() =>
      adapter.preview({
        kind: "cast_attachment",
        mission_id: missionId,
        target_ref: "internship:toyosu-robotics-2026",
        display_label: "添付",
        attachment_ref: "attachment:1",
        file_name: "es-draft.pdf",
        mime_type: "application/octet-stream" as never,
      }),
    ).toThrow("MIME type");
    expect(() =>
      adapter.preview({
        ...applicationInput,
        required_documents: ["student al23088@sic.shibaura-it.ac.jp"],
      }),
    ).toThrow("personal or credential");
  });

  it("marks an unconfigured executor unavailable instead of claiming success", async () => {
    const adapter = new CastActionAdapter();
    const preview = adapter.preview(applicationInput);
    adapter.confirm(preview.preview_id, {
      phase: "primary",
      phrase: "実行を確認",
    });

    expect(await adapter.execute(preview.preview_id)).toEqual({
      status: "unavailable",
      reason_code: "institutional_write_not_configured",
    });
    expect(adapter.get(preview.preview_id)?.status).toBe("blocked");
  });

  it("expires previews and prevents replay after rejection or execution", async () => {
    const { executor } = executorFixture();
    const adapter = new CastActionAdapter(executor);
    const created = new Date("2026-08-22T00:00:00.000Z");
    const preview = adapter.preview(applicationInput, created);

    expect(
      adapter.get(preview.preview_id, new Date("2026-08-22T00:11:00.000Z"))
        ?.status,
    ).toBe("expired");
    expect(() =>
      adapter.confirm(
        preview.preview_id,
        { phase: "primary", phrase: "実行を確認" },
        new Date("2026-08-22T00:11:00.000Z"),
      ),
    ).toThrow("expired");

    const rejectedPreview = adapter.preview(applicationInput);
    expect(adapter.reject(rejectedPreview.preview_id).status).toBe("rejected");
    expect(() =>
      adapter.confirm(rejectedPreview.preview_id, {
        phase: "primary",
        phrase: "実行を確認",
      }),
    ).toThrow("terminal");

    const executedPreview = adapter.preview(applicationInput);
    adapter.confirm(executedPreview.preview_id, {
      phase: "primary",
      phrase: "実行を確認",
    });
    await adapter.execute(executedPreview.preview_id);
    expect(() => adapter.reject(executedPreview.preview_id)).toThrow(
      "Executed",
    );
  });
});
