import { randomBytes } from "node:crypto";
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
const auditBuild = process.env.ORBIT_AUDIT_BUILD === "1";
const auditPort = Number.parseInt(
  process.env.ORBIT_AUDIT_BRIDGE_PORT?.trim() || "47123",
  10,
);
if (
  auditBuild &&
  (!Number.isInteger(auditPort) || auditPort < 1024 || auditPort > 65535)
) {
  throw new Error("ORBIT_AUDIT_BRIDGE_PORT must be a valid local TCP port.");
}
const auditSecret = auditBuild ? randomBytes(32).toString("base64url") : "";

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

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

// Agent auth uses a Web application client for an authorization-code + PKCE
// exchange. Calendar keeps a separate Chrome Extension client in manifest.oauth2.
const agentOAuthClientId =
  process.env.ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID?.trim() ||
  parseLocalEnvValue(localEnv, "ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID");
const agentApiBase =
  process.env.ORBIT_AGENT_API_BASE?.trim() ||
  parseLocalEnvValue(localEnv, "ORBIT_AGENT_API_BASE");
const extensionOAuthClientId =
  process.env.ORBIT_GOOGLE_EXTENSION_OAUTH_CLIENT_ID?.trim() ||
  parseLocalEnvValue(localEnv, "ORBIT_GOOGLE_EXTENSION_OAUTH_CLIENT_ID");

const bundleOptions = {
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: "chrome114",
  legalComments: "none",
  define: {
    __ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID__: JSON.stringify(
      agentOAuthClientId ?? "",
    ),
    __ORBIT_AUDIT_BUILD__: JSON.stringify(auditBuild),
    __ORBIT_AUDIT_BRIDGE_PORT__: JSON.stringify(auditBuild ? auditPort : 0),
    __ORBIT_AUDIT_BRIDGE_SECRET__: JSON.stringify(auditSecret),
    __ORBIT_AGENT_API_BASE__: JSON.stringify(agentApiBase ?? ""),
  },
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
    entryPoints: [resolve(packageRoot, "src/content/cast-support-reader.ts")],
    outfile: resolve(outputDirectory, "cast-support-reader.js"),
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

const ocrDirectory = resolve(outputDirectory, "ocr");
const ocrLanguageDirectory = resolve(ocrDirectory, "lang");
await mkdir(ocrLanguageDirectory, { recursive: true });
await Promise.all([
  copyFile(
    resolve(packageRoot, "ocr/worker.min.js"),
    resolve(ocrDirectory, "worker.min.js"),
  ),
  copyFile(
    resolve(packageRoot, "ocr/tesseract-core.wasm.js"),
    resolve(ocrDirectory, "tesseract-core.wasm.js"),
  ),
  copyFile(
    resolve(packageRoot, "ocr/tesseract-core.wasm"),
    resolve(ocrDirectory, "tesseract-core.wasm"),
  ),
  copyFile(
    resolve(packageRoot, "ocr/lang/eng.traineddata.gz"),
    resolve(ocrLanguageDirectory, "eng.traineddata.gz"),
  ),
  copyFile(
    resolve(packageRoot, "ocr/lang/jpn.traineddata.gz"),
    resolve(ocrLanguageDirectory, "jpn.traineddata.gz"),
  ),
  copyFile(
    resolve(
      packageRoot,
      "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    ),
    resolve(outputDirectory, "pdf.worker.min.mjs"),
  ),
]);

const manifest = JSON.parse(
  await readFile(resolve(outputDirectory, "manifest.json"), "utf8"),
);

if (extensionOAuthClientId) {
  manifest.oauth2 = {
    client_id: extensionOAuthClientId,
    scopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events.owned.readonly",
    ],
  };
  await writeFile(
    resolve(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

if (auditBuild) {
  // The CLI reads this file once to authenticate the temporary local bridge.
  // It is emitted only for an explicit audit build and is ignored by git.
  await writeFile(
    resolve(outputDirectory, "audit-bridge.json"),
    `${JSON.stringify({ version: "v1", port: auditPort, secret: auditSecret }, null, 2)}\n`,
    "utf8",
  );
}

const requiredFiles = [
  "manifest.json",
  "service-worker.js",
  "content-script.js",
  "browser-reader.js",
  "cast-support-reader.js",
  "sidepanel.html",
  "sidepanel.js",
  "workspace.html",
  "workspace.js",
  "styles.css",
  "pdf.worker.min.mjs",
  "ocr/worker.min.js",
  "ocr/tesseract-core.wasm.js",
  "ocr/tesseract-core.wasm",
  "ocr/lang/eng.traineddata.gz",
  "ocr/lang/jpn.traineddata.gz",
];
if (auditBuild) requiredFiles.push("audit-bridge.json");

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
      "https://sit-orbit-demo-api.grayground-578aed68.japaneast.azurecontainerapps.io/*",
      "https://www.googleapis.com/*",
      "https://oauth2.googleapis.com/*",
      "https://syllabus.sic.shibaura-it.ac.jp/*",
      "https://sitrus.sic.shibaura-it.ac.jp/*",
      "https://*/*",
      "http://*/*",
    ]) ||
  JSON.stringify(manifest.web_accessible_resources) !==
    JSON.stringify([
      {
        resources: ["pdf.worker.min.mjs", "ocr/*"],
        matches: ["https://scombz.shibaura-it.ac.jp/*"],
      },
    ]) ||
  manifest.optional_host_permissions !== undefined ||
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
