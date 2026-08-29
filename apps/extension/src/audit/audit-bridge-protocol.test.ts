import { describe, expect, it } from "vitest";
import {
  AUDIT_BRIDGE_MAX_FRAME_BYTES,
  auditFrameByteLength,
  isAuditCommand,
  sanitizeAuditValue,
} from "./audit-bridge-protocol";

describe("audit bridge protocol", () => {
  it("accepts only bounded natural-language commands", () => {
    expect(
      isAuditCommand({
        type: "chat",
        request_id: "request-1",
        conversation_id: "conversation-1",
        message: "今週の授業を教えて",
        source_ref: "orbit-source://source-1234567890",
      }),
    ).toBe(true);
    expect(
      isAuditCommand({
        type: "chat",
        request_id: "request-1",
        conversation_id: "conversation-1",
        message: "x",
        source_ref: "https://example.invalid/?tab=secret",
      }),
    ).toBe(false);
    expect(
      isAuditCommand({
        type: "chat",
        request_id: "request-1",
        conversation_id: "conversation-1",
        message: "x".repeat(8_001),
      }),
    ).toBe(false);
    expect(
      isAuditCommand({
        type: "clear",
        request_id: "request-2",
        conversation_id: "conversation-1",
      }),
    ).toBe(true);
    expect(
      isAuditCommand({
        type: "clear",
        request_id: "request-2",
        conversation_id: "conversation-1",
        tab_id: 42,
      }),
    ).toBe(false);
  });

  it("redacts identifiers, query values and raw payload fields", () => {
    const sanitized = sanitizeAuditValue({
      email: "student@example.invalid",
      internal_id: "secret-id",
      locator: "https://example.invalid/material?idnumber=secret",
      raw_html: "<html>private</html>",
      title: "公開資料",
    }) as Record<string, unknown>;
    expect(JSON.stringify(sanitized)).not.toContain("student@example.invalid");
    expect(JSON.stringify(sanitized)).not.toContain("secret-id");
    expect(JSON.stringify(sanitized)).not.toContain("idnumber=secret");
    expect(sanitized.raw_html).toBe("[省略]");

    const rawCanary = sanitizeAuditValue({
      html: "<html><body>private</body></html>",
      pdf_content: "%PDF-1.7\nprivate bytes",
      text: "data:application/pdf;base64,JVBERi0xLjQ=",
      safe_text: "授業資料の本文です。",
    }) as Record<string, unknown>;
    expect(JSON.stringify(rawCanary)).not.toMatch(
      /private|JVBERi0|%PDF-|<html>/iu,
    );
    expect(rawCanary.safe_text).toBe("授業資料の本文です。");

    const embeddedUrl = sanitizeAuditValue(
      "本文 https://scombz.shibaura-it.ac.jp/lms/course?idnumber=secret&resourceId=file#page=2 を参照",
    ) as string;
    expect(embeddedUrl).not.toContain("idnumber=secret");
    expect(embeddedUrl).not.toContain("resourceId=file");
    expect(embeddedUrl).not.toContain("#page=2");

    const oversized = sanitizeAuditValue(
      `${"x".repeat(12_050)} student@example.invalid?token=secret`,
    ) as string;
    expect(oversized).not.toContain("student@example.invalid");
    expect(oversized).not.toContain("token=secret");

    expect(
      auditFrameByteLength({
        type: "keepalive",
        sequence: 1,
      }),
    ).toBeLessThan(AUDIT_BRIDGE_MAX_FRAME_BYTES);
  });
});
