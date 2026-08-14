import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
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
    entryPoints: [resolve(packageRoot, "src/sidepanel/index.tsx")],
    outfile: resolve(outputDirectory, "sidepanel.js"),
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
    resolve(packageRoot, "src/sidepanel/styles.css"),
    resolve(outputDirectory, "styles.css"),
  ),
]);

const manifest = JSON.parse(
  await readFile(resolve(outputDirectory, "manifest.json"), "utf8"),
);
const requiredFiles = [
  "manifest.json",
  "service-worker.js",
  "content-script.js",
  "sidepanel.html",
  "sidepanel.js",
  "styles.css",
];

if (
  manifest.manifest_version !== 3 ||
  JSON.stringify(manifest.permissions) !== JSON.stringify(["sidePanel"]) ||
  JSON.stringify(manifest.host_permissions) !==
    JSON.stringify(["https://scombz.shibaura-it.ac.jp/*"]) ||
  manifest.side_panel !== undefined ||
  manifest.background?.service_worker !== "service-worker.js"
) {
  throw new Error(
    "Generated extension manifest is outside the Branch 1 contract",
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
