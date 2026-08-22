import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import {
  CareerVault,
  MemorySessionKeyStore,
  MemoryVaultStore,
} from "../privacy/career-vault";
import { PseudonymizationGateway } from "../privacy/pseudonymization";
import {
  CAST_COMPANY_DETAIL_URL,
  CAST_COMPANY_EXAM_REPORT_URL,
  extractCastHistory,
  isCastCompanyDetailUrl,
  isCastCompanyExamReportUrl,
  pseudonymizeCastHistoryForPrompt,
} from "./cast-history-reports-reader";

const fixture = readFileSync(
  fileURLToPath(
    new URL("./fixtures/cast-history-company.html", import.meta.url),
  ),
  "utf8",
);

const PASSPHRASE = "cast history fixture passphrase";

function createVault() {
  const store = new MemoryVaultStore();
  const vault = new CareerVault({
    store,
    sessionKeyStore: new MemorySessionKeyStore(),
  });
  return { store, vault };
}

describe("CAST history and reports reader", () => {
  const vaults: CareerVault[] = [];

  afterEach(async () => {
    await Promise.all(vaults.splice(0).map((vault) => vault.lock()));
  });

  it("accepts only the observed company and report paths", () => {
    expect(isCastCompanyDetailUrl(CAST_COMPANY_DETAIL_URL)).toBe(true);
    expect(
      isCastCompanyDetailUrl(`${CAST_COMPANY_DETAIL_URL}?code=9500711`),
    ).toBe(false);
    expect(isCastCompanyExamReportUrl(CAST_COMPANY_EXAM_REPORT_URL)).toBe(true);
    expect(
      isCastCompanyExamReportUrl(`${CAST_COMPANY_EXAM_REPORT_URL}#report`),
    ).toBe(false);
    expect(
      isCastCompanyDetailUrl("https://example.com/career/company_detail_view"),
    ).toBe(false);
  });

  it("extracts local hiring records and selection reports without form or PDF data", () => {
    const { document } = parseHTML(fixture);
    const snapshot = extractCastHistory(document, CAST_COMPANY_DETAIL_URL);
    expect(snapshot).toEqual(
      expect.objectContaining({
        schema_version: "v1",
        company_name: "合成精密株式会社 (ゴウセイセイミツ)",
        company_code: "9500711",
        obog_available: true,
      }),
    );
    expect(snapshot?.hiring_records).toHaveLength(2);
    expect(snapshot?.selection_reports).toHaveLength(1);
    expect(snapshot?.people).toEqual([
      expect.objectContaining({
        name: "山田 太郎",
        role: "unknown",
        graduation_year: 2024,
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("学生 太郎");
    expect(JSON.stringify(snapshot)).not.toContain("student-name.pdf");
  });

  it("replaces names with mission-scoped aliases before prompt use", async () => {
    const { store, vault } = createVault();
    vaults.push(vault);
    await vault.create(PASSPHRASE);
    const snapshot = extractCastHistory(
      parseHTML(fixture).document,
      CAST_COMPANY_DETAIL_URL,
    );
    if (!snapshot) throw new Error("history fixture extraction failed");
    const gateway = new PseudonymizationGateway(vault);
    const projection = await pseudonymizeCastHistoryForPrompt(
      snapshot,
      await gateway.startMission("cast-history-a"),
    );
    expect(projection.hiring_records[0]).toEqual(
      expect.objectContaining({
        person_alias: expect.stringMatching(/^人物-[A-Z2-7]{8}$/u),
      }),
    );
    expect(projection.selection_reports[0]?.person_alias).toBeNull();
    expect(JSON.stringify(projection)).not.toContain("山田");
    expect(JSON.stringify(projection)).not.toContain("9500711");
    expect(JSON.stringify(projection)).not.toContain("report-1");
    expect(JSON.stringify(store.snapshot())).not.toContain("山田 太郎");
  });

  it("fails closed on login pages, drift, and unconfirmed report pages", () => {
    const login = parseHTML(fixture).document;
    login.body.innerHTML = '<input type="password" />';
    expect(extractCastHistory(login, CAST_COMPANY_DETAIL_URL)).toBeNull();

    const drifted = parseHTML(fixture).document;
    drifted.querySelector("#employment")?.remove();
    expect(extractCastHistory(drifted, CAST_COMPANY_DETAIL_URL)).toBeNull();

    expect(
      extractCastHistory(
        parseHTML(fixture).document,
        CAST_COMPANY_EXAM_REPORT_URL,
      ),
    ).toBeNull();
  });
});
