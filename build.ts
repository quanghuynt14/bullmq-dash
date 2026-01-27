import { rmSync, writeFileSync, readFileSync } from "node:fs";

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
  external: ["bullmq", "ioredis", "@opentui/core", "dotenv", "zod"],
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
const tsc = Bun.spawn(["bunx", "tsc", "--emitDeclarationOnly", "--declaration", "--outDir", "dist"], {
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await tsc.exited;
if (exitCode !== 0) {
  console.error("Declaration generation failed");
  process.exit(1);
}

console.log("Build completed successfully");
