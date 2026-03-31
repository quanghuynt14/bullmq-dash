import { rmSync, writeFileSync, readFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Clean dist folder
rmSync("./dist", { recursive: true, force: true });

// Build with Bun
const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  sourcemap: "linked",
  minify: false,
  external: ["bullmq", "ioredis", "@opentui/core", "zod"],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Add shebang to output
const outputPath = "./dist/index.js";
const content = readFileSync(outputPath, "utf-8");
writeFileSync(outputPath, `#!/usr/bin/env bun\n${content}`);

// Generate .d.ts using tsc
const tsc = Bun.spawn(
  ["bunx", "tsc", "--emitDeclarationOnly", "--declaration", "--outDir", "dist"],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);

const exitCode = await tsc.exited;
if (exitCode !== 0) {
  console.error("Declaration generation failed");
  process.exit(1);
}

// Copy web build output
const webBuildDir = resolve(import.meta.dirname, "web/build");
const webOutputDir = resolve(import.meta.dirname, "dist/web");

if (existsSync(webBuildDir)) {
  mkdirSync(webOutputDir, { recursive: true });
  cpSync(webBuildDir, webOutputDir, { recursive: true });
  console.log("Copied web build to dist/web/");
} else {
  console.warn("Warning: web/build not found. Run 'bun run build:web' first.");
}

console.log("Build completed successfully");
