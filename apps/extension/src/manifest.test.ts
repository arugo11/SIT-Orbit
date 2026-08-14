import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as {
  manifest_version: number;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker: string };
  side_panel?: { default_path?: string };
  content_scripts: Array<{ matches: string[]; js: string[] }>;
};

describe("production extension contract", () => {
  it("keeps the raw MV3 shell within the requested permissions", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["sidePanel"]);
    expect(manifest.host_permissions).toEqual([
      "https://scombz.shibaura-it.ac.jp/*",
      "http://localhost:8000/*",
    ]);
    expect(manifest.background.service_worker).toBe("service-worker.js");
    expect(manifest.side_panel).toBeUndefined();
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["https://scombz.shibaura-it.ac.jp/*"],
        js: ["content-script.js"],
        run_at: "document_idle",
      },
    ]);
  });
});
