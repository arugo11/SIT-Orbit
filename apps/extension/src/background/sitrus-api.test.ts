import { describe, expect, it, vi } from "vitest";
import {
  readAuthenticatedSitrusGrades,
  SITRUS_API_PATHS,
  type SitrusApiError,
} from "./sitrus-api";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("authenticated SITRUS API reader", () => {
  it("uses the origin-root API mounts used by the current SITRUS frontend", () => {
    expect(SITRUS_API_PATHS).toEqual({
      token: "/top/app/Token",
      student: "/app/SITRUS/gakuseiInfoUser",
      courses: "/app/SITRUS/risyu",
      credits: "/app/SITRUS/JissekiSyukei",
    });
  });

  it("uses only the authenticated identity and projects grades and credit totals", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ preferred_username: "account-1" }))
      .mockResolvedValueOnce(
        json([{ gakuseki_no: "STUDENT-1", name: "秘密氏名" }]),
      )
      .mockResolvedValueOnce(
        json([
          {
            hantei_name: "合格",
            hyoka: "A",
            kamoku_name: "合成科目",
            kaiko_nendo: "2025",
            ki_name: "後期",
            kamoku_cd: "FORBIDDEN-CODE",
            tani_su: "2",
            kyoin_name: "秘密教員",
            kyoshitsu_name: "秘密教室",
          },
        ]),
      )
      .mockResolvedValueOnce(
        json([
          {
            keiretu_title: "専門科目",
            tani_title: "選択",
            toki_kamoku: "1",
            toki_tani: "2",
            kamoku_su: "10",
            tani_su: "20",
          },
        ]),
      );

    const result = await readAuthenticatedSitrusGrades(
      fetcher,
      () => new Date("2026-09-02T00:00:00.000Z"),
    );

    expect(result).toEqual({
      schema_version: "v1",
      status: "known",
      report_label: "取得済み科目・単位数",
      grades: [
        {
          subject: "合成科目",
          credits: 2,
          grade: "A",
          outcome: "合格",
          year: 2025,
          term: 2,
        },
      ],
      credit_summaries: [
        {
          category: "専門科目",
          credit_type: "選択",
          current_course_count: 1,
          current_credits: 2,
          cumulative_course_count: 10,
          cumulative_credits: 20,
        },
      ],
      observed_at: "2026-09-02T00:00:00.000Z",
      reason_code: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    const urls = fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.pathname)).toEqual([
      SITRUS_API_PATHS.token,
      SITRUS_API_PATHS.student,
      SITRUS_API_PATHS.courses,
      SITRUS_API_PATHS.credits,
    ]);
    expect(urls[1]?.searchParams.get("cardsubject")).toBe("account-1");
    expect(urls[2]?.searchParams.get("gakusei_no")).toBe("STUDENT-1");
    expect(urls[3]?.searchParams.get("gakusei_no")).toBe("STUDENT-1");
    expect(JSON.stringify(result)).not.toMatch(
      /STUDENT-1|秘密氏名|秘密教員|秘密教室|FORBIDDEN-CODE/u,
    );
  });

  it("accepts the observed Result/Message JSON envelope", async () => {
    const envelope = (value: unknown) =>
      json({ Result: "true", Message: JSON.stringify(value) });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ id_data: { preferred_username: "account-1" } }),
      )
      .mockResolvedValueOnce(envelope([{ gakuseki_no: "STUDENT-1" }]))
      .mockResolvedValueOnce(
        envelope([
          {
            hantei_name: "合格",
            hyoka: "B",
            kamoku_name: "合成科目",
            kaiko_nendo: 2025,
            ki_name: 1,
            tani_su: 2,
          },
        ]),
      )
      .mockResolvedValueOnce(envelope([]));

    await expect(readAuthenticatedSitrusGrades(fetcher)).resolves.toMatchObject(
      {
        status: "known",
        grades: [{ subject: "合成科目", grade: "B" }],
      },
    );
  });

  it("accepts the current d/t envelope and latest-term credit fields", async () => {
    const wrapped = (value: unknown) =>
      json({ d: value, t: "2026-09-02T00:00:00+09:00" });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ authenticated: true, preferred_username: "account-1" }),
      )
      .mockResolvedValueOnce(wrapped([{ gakuseki_no: "STUDENT-1" }]))
      .mockResolvedValueOnce(
        wrapped([
          {
            hantei_name: "合格",
            hyoka: "A",
            kamoku_name: "合成科目",
            kaiko_nendo: 2026,
            ki_name: "前期",
            tani_su: 2,
          },
        ]),
      )
      .mockResolvedValueOnce(
        wrapped([
          {
            keiretu_title: "専門科目",
            tani_title: "選択",
            kamoku_su_latest: 1,
            tani_su_latest: 2,
            kamoku_su: 10,
            tani_su: 20,
          },
        ]),
      );

    await expect(readAuthenticatedSitrusGrades(fetcher)).resolves.toMatchObject(
      {
        status: "known",
        grades: [{ subject: "合成科目", grade: "A" }],
        credit_summaries: [
          {
            category: "専門科目",
            current_course_count: 1,
            current_credits: 2,
            cumulative_course_count: 10,
            cumulative_credits: 20,
          },
        ],
      },
    );
  });

  it("classifies an HTML login response as reauthentication required", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("<html>login</html>", { status: 200 }));

    await expect(readAuthenticatedSitrusGrades(fetcher)).rejects.toMatchObject({
      reasonCode: "login_required",
      reauthRequired: true,
    } satisfies Partial<SitrusApiError>);
  });

  it("rejects oversized and structurally empty responses", async () => {
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-length": "1000001" },
      }),
    );
    await expect(
      readAuthenticatedSitrusGrades(oversized),
    ).rejects.toMatchObject({
      reasonCode: "response_too_large",
    });

    const empty = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ preferred_username: "account-1" }))
      .mockResolvedValueOnce(json([{ gakuseki_no: "STUDENT-1" }]))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([]));
    await expect(readAuthenticatedSitrusGrades(empty)).rejects.toMatchObject({
      reasonCode: "sitrus_structure_changed",
      reauthRequired: false,
    });
  });
});
