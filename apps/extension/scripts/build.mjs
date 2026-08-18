import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageRoot, "dist");

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

const bundleOptions = {
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: "chrome114",
  legalComments: "none",
};

await Promise.all([
  build({
    ...bundleOptions,
    entryPoints: [resolve(packageRoot, "src/background/service-worker.ts")],
    outfile: resolve(outputDirectory, "service-worker.js"),
  }),
  build({
    ...bundleOptions,
    entryPoints: [resolve(packageRoot, "src/content/content-script.ts")],
    outfile: resolve(outputDirectory, "content-script.js"),
  }),
  build({
    ...bundleOptions,
    entryPoints: [resolve(packageRoot, "src/content/browser-reader.ts")],
    outfile: resolve(outputDirectory, "browser-reader.js"),
  }),
  build({
    ...bundleOptions,
    entryPoints: [resolve(packageRoot, "src/sidepanel/index.tsx")],
    outfile: resolve(outputDirectory, "sidepanel.js"),
  }),
  build({
    ...bundleOptions,
    entryPoints: [resolve(packageRoot, "src/workspace/index.tsx")],
    outfile: resolve(outputDirectory, "workspace.js"),
  }),
]);

await Promise.all([
  copyFile(
    resolve(packageRoot, "manifest.json"),
    resolve(outputDirectory, "manifest.json"),
  ),
  copyFile(
    resolve(packageRoot, "src/sidepanel/sidepanel.html"),
    resolve(outputDirectory, "sidepanel.html"),
  ),
  copyFile(
    resolve(packageRoot, "src/workspace/workspace.html"),
    resolve(outputDirectory, "workspace.html"),
  ),
  copyFile(
    resolve(packageRoot, "src/sidepanel/styles.css"),
    resolve(outputDirectory, "styles.css"),
  ),
]);

const manifest = JSON.parse(
  await readFile(resolve(outputDirectory, "manifest.json"), "utf8"),
);

function parseLocalEnvValue(source, name) {
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (match?.[1] !== name) {
      continue;
    }
    const value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1).trim();
    }
    return value.trim();
  }
  return undefined;
}

let localEnv = "";
try {
  localEnv = await readFile(resolve(packageRoot, ".env.local"), "utf8");
} catch {
  // Local OAuth configuration is optional for CI and fixture builds.
}

const oauthClientId =
  process.env.ORBIT_GOOGLE_OAUTH_CLIENT_ID?.trim() ||
  parseLocalEnvValue(localEnv, "ORBIT_GOOGLE_OAUTH_CLIENT_ID");
if (oauthClientId) {
  manifest.oauth2 = {
    client_id: oauthClientId,
    scopes: ["https://www.googleapis.com/auth/calendar.events.owned.readonly"],
  };
  await writeFile(
    resolve(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

const requiredFiles = [
  "manifest.json",
  "service-worker.js",
  "content-script.js",
  "browser-reader.js",
  "sidepanel.html",
  "sidepanel.js",
  "workspace.html",
  "workspace.js",
  "styles.css",
];

if (
  manifest.manifest_version !== 3 ||
  JSON.stringify(manifest.permissions) !==
    JSON.stringify([
      "sidePanel",
      "identity",
      "storage",
      "scripting",
      "unlimitedStorage",
    ]) ||
  JSON.stringify(manifest.host_permissions) !==
    JSON.stringify([
      "https://scombz.shibaura-it.ac.jp/*",
      "http://localhost:8000/*",
      "https://www.googleapis.com/*",
      "https://oauth2.googleapis.com/*",
      "https://syllabus.sic.shibaura-it.ac.jp/*",
    ]) ||
  JSON.stringify(manifest.optional_host_permissions) !==
    JSON.stringify(["https://*/*", "http://*/*"]) ||
  manifest.side_panel !== undefined ||
  manifest.background?.service_worker !== "service-worker.js"
) {
  throw new Error(
    "Generated extension manifest is outside the production permission contract",
  );
}

await Promise.all(
  requiredFiles.map(async (file) => {
    const filePath = resolve(outputDirectory, file);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`Generated extension artifact is not a file: ${file}`);
    }
  }),
);
