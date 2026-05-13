/**
 * Benchmark for `compactRemovedJobs` and friends.
 *
 * Measures compaction wall-clock time and EXPLAIN QUERY PLAN at scale to
 * decide whether the partial `idx_jobs_active` index (which covers live
 * rows only) is enough or whether we also need an index for soft-deleted
 * rows. Run via `bun scripts/bench-compaction.ts`.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../src/config.js";
import {
  closeSqliteDb,
  compactRemovedJobs,
  createSqliteDb,
  findResurrectedIdsByStagingDiff,
  findStaleIdsByStagingDiff,
  getSqliteDb,
  softDeleteJobsByIds,
} from "../src/data/sqlite.js";

setConfig({
  redis: { host: "localhost", port: 6379, db: 0 },
  pollInterval: 3000,
  prefix: "bull",
  retentionMs: 1,
});

function seedJobs(db: Database, queue: string, n: number, removedAt: number | null): void {
  const stmt = db.prepare(
    "INSERT INTO jobs (id, queue, name, state, timestamp, removed_at) VALUES (?, ?, NULL, 'completed', 0, ?)",
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      stmt.run(`${queue}-${removedAt === null ? "live" : "gone"}-${i}`, queue, removedAt);
    }
  });
  tx();
}

function explain(db: Database, sql: string, ...params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail).join(" | ");
}

function bench(label: string, fn: () => void, runs = 5): void {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(runs / 2)]!;
  const min = samples[0]!;
  const max = samples[runs - 1]!;
  console.log(
    `  ${label.padEnd(48)} median=${median.toFixed(2)}ms  min=${min.toFixed(2)}  max=${max.toFixed(2)}`,
  );
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "bullmq-dash-bench-"));
  const dbPath = join(tmp, "bench.db");
  try {
    createSqliteDb(dbPath);
    const db = getSqliteDb();

    // Scale: 100k live + 5k soft-deleted, all of which are past retention.
    const LIVE = 100_000;
    const GONE = 5_000;
    console.log(
      `Seeding ${LIVE.toLocaleString()} live + ${GONE.toLocaleString()} soft-deleted rows…`,
    );
    seedJobs(db, "q", LIVE, null);
    seedJobs(db, "q", GONE, 1); // removed long ago, well past retention=1ms

    console.log("\nQuery plans:");
    console.log(
      "  compaction SELECT:",
      explain(
        db,
        "SELECT COUNT(*) as n FROM jobs WHERE removed_at IS NOT NULL AND removed_at < ?",
        Date.now(),
      ),
    );
    console.log(
      "  compaction DELETE:",
      explain(db, "DELETE FROM jobs WHERE removed_at IS NOT NULL AND removed_at < ?", Date.now()),
    );

    console.log("\nTimings (5 runs each, median reported):");
    // Re-seed for each compaction run since DELETE removes rows.
    bench("compactRemovedJobs (5k of 105k)", () => {
      // re-seed only the soft-deleted rows
      db.prepare("DELETE FROM jobs WHERE removed_at IS NOT NULL").run();
      seedJobs(db, "q", GONE, 1);
      compactRemovedJobs(Date.now(), 1);
    });

    // Re-seed soft-deleted rows for the read-side benches.
    seedJobs(db, "q", GONE, 1);

    // Reuse the staging-table primitives indirectly:
    db.exec("DROP TABLE IF EXISTS temp.sync_staging");
    db.exec(`CREATE TEMP TABLE sync_staging (
      id TEXT NOT NULL, queue TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY (queue, id)
    )`);
    // Populate staging with all live IDs (steady state — nothing stale, no resurrections).
    const stagingStmt = db.prepare(
      "INSERT INTO sync_staging (id, queue, state) VALUES (?, ?, 'completed')",
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < LIVE; i++) stagingStmt.run(`q-live-${i}`, "q");
    });
    tx();

    bench("findStaleIdsByStagingDiff (steady state)", () => {
      findStaleIdsByStagingDiff("q");
    });
    bench("findResurrectedIdsByStagingDiff (steady state)", () => {
      findResurrectedIdsByStagingDiff("q");
    });

    console.log("\nNow soft-delete a fresh batch and re-measure compaction:");
    seedJobs(db, "q", GONE, 1);
    bench("softDeleteJobsByIds (1k of fresh live)", () => {
      const ids = Array.from({ length: 1_000 }, (_, i) => `q-live-${i}`);
      softDeleteJobsByIds("q", ids, Date.now());
      // restore for next iteration
      db.prepare(
        "UPDATE jobs SET removed_at = NULL WHERE id IN (" + ids.map(() => "?").join(",") + ")",
      ).run(...ids);
    });
  } finally {
    closeSqliteDb();
    rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
