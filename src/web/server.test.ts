import { describe, expect, it } from "bun:test";
import type { Context } from "../context.js";
import { createWebHandler } from "./server.js";

function fakeContext(prefix: string = "bull"): Context {
  return {
    config: {
      redis: { host: "localhost", port: 6379, db: 0 },
      pollInterval: 3000,
      prefix,
      cacheTtlMs: 86_400_000,
    },
    redis: {
      status: "ready",
      connect: async () => {},
      quit: async () => {},
      scan: async () => ["0", []],
      del: async () => 0,
      ping: async () => "PONG",
      info: async () => "",
    },
    db: {} as Context["db"],
    queueCache: new Map(),
    queueNamesCache: null,
    queueStore: { lastCleanupAt: null },
  };
}

describe("createWebHandler", () => {
  it("serves the dashboard shell without exposing Redis connection details", async () => {
    const response = await createWebHandler(fakeContext())(new Request("http://localhost:3000/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("bullmq-dash");
    expect(html).toContain("rank: task size");
    expect(html).toContain("rank: completed");
    expect(html).toContain("filter queues");
    expect(html).toContain("filter jobs");
    expect(html).toContain("retry failed");
    expect(html).not.toContain("localhost:6379");
  });

  it("renders read-only mode without live retry controls", async () => {
    const response = await createWebHandler(fakeContext(), { readOnly: true })(
      new Request("http://localhost:3000/"),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("read-only");
    expect(html).toContain("preview retry");
    expect(html).not.toContain("retry failed");
  });

  it("escapes the configured Redis key prefix in the dashboard shell", async () => {
    const response = await createWebHandler(fakeContext("<script>alert(1)</script>"))(
      new Request("http://localhost:3000/"),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("\\u003cscript>alert(1)");
  });

  it("returns CONFIG_ERROR for invalid queue ranking input", async () => {
    const response = await createWebHandler(fakeContext())(
      new Request("http://localhost:3000/api/overview?sortBy=bogus"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("rejects live retry requests that are not JSON before touching Redis", async () => {
    const response = await createWebHandler(fakeContext())(
      new Request("http://localhost:3000/api/queues/email/jobs/42/retry", {
        method: "POST",
        body: "dryRun=false",
        headers: { "content-type": "text/plain" },
      }),
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("requires explicit confirmation for live retry requests", async () => {
    const response = await createWebHandler(fakeContext())(
      new Request("http://localhost:3000/api/queues/email/retry-failed", {
        method: "POST",
        body: JSON.stringify({ dryRun: false }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CONFIG_ERROR",
    });
  });

  it("blocks live retry requests when web mode is read-only", async () => {
    const response = await createWebHandler(fakeContext(), { readOnly: true })(
      new Request("http://localhost:3000/api/queues/email/retry-failed", {
        method: "POST",
        body: JSON.stringify({ dryRun: false, confirm: true }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "READ_ONLY",
    });
  });
});
