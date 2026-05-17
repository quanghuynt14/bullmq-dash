import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("./package.json", "utf-8")) as {
  version?: unknown;
};

if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
  throw new Error("Invalid package.json version");
}

// Clean dist folder
rmSync("./dist", { recursive: true, force: true });

// Build with Bun
const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  sourcemap: "none",
  minify: false,
  external: ["bullmq", "@opentui/core"],
  define: {
    BUILD_PACKAGE_VERSION: JSON.stringify(packageJson.version),
  },
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
chmodSync(outputPath, 0o755);

console.log("Build completed successfully");
