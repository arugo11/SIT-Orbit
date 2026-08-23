import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifestSource = readFileSync(
  new URL("../manifest.json", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(manifestSource) as {
  manifest_version: number;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
  background: { service_worker: string };
  oauth2?: { client_id?: string; scopes?: string[] };
  side_panel?: { default_path?: string };
  content_scripts: Array<{ matches: string[]; js: string[] }>;
};

describe("production extension contract", () => {
  it("keeps the raw MV3 shell within the requested permissions", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual([
      "sidePanel",
      "identity",
      "storage",
      "scripting",
      "unlimitedStorage",
    ]);
    expect(manifest.host_permissions).toEqual([
      "https://scombz.shibaura-it.ac.jp/*",
      "https://sit-orbit-demo-api.grayground-578aed68.japaneast.azurecontainerapps.io/*",
      "https://www.googleapis.com/*",
      "https://oauth2.googleapis.com/*",
      "https://syllabus.sic.shibaura-it.ac.jp/*",
      "https://sitrus.sic.shibaura-it.ac.jp/*",
      "https://*/*",
      "http://*/*",
    ]);
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.background.service_worker).toBe("service-worker.js");
    expect(manifest.side_panel).toBeUndefined();
    expect(manifest.oauth2).toBeUndefined();
    expect(manifest.content_scripts).toEqual([
      {
        matches: [
          "https://scombz.shibaura-it.ac.jp/*",
          "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/*",
          "https://shibaura.pita.services/career/*",
        ],
        js: ["content-script.js"],
        run_at: "document_idle",
      },
    ]);
  });

  it("does not add broad Drive OAuth scopes or remote Picker scripts", () => {
    const buildSource = readFileSync(
      new URL("../scripts/build.mjs", import.meta.url),
      "utf8",
    );
    for (const source of [manifestSource, buildSource]) {
      expect(source).not.toMatch(/googleapis\.com\/auth\/drive/i);
      expect(source).not.toMatch(/googleapis\.com\/auth\/drive\.readonly/i);
      expect(source).not.toMatch(/apis\.google\.com\/js\/api\.js/i);
      expect(source).not.toMatch(/gapi\.load\(['"]picker/i);
      expect(source).not.toMatch(/Google Picker/i);
    }
    expect(manifest.oauth2).toBeUndefined();
  });

  it("builds the workspace as an extension page without adding tabs permission", () => {
    const buildSource = readFileSync(
      new URL("../scripts/build.mjs", import.meta.url),
      "utf8",
    );
    expect(buildSource).toContain('"workspace.html"');
    expect(buildSource).toContain('"workspace.js"');
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.permissions).not.toContain("debugger");
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.permissions).not.toContain("history");
    expect(manifest.permissions).not.toContain("webRequest");
  });
});
