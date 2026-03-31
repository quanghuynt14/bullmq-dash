import { getConfig } from "../config.js";
import { connectRedis } from "../data/redis.js";
import { createSqliteDb, fullSync } from "./sqlite.js";
import {
  handleQueuesList,
  handleJobsList,
  handleJobDetail,
  handleSchedulersList,
  handleSchedulerDetail,
  handleMetrics,
  handleNotFound,
} from "./routes.js";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

function getWebRoot(): string {
  const devPath = resolve(import.meta.dirname, "../../web/build");
  const prodPath = resolve(import.meta.dirname, "../web");
  return existsSync(prodPath) ? prodPath : devPath;
}

function getMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mimes: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    png: "image/png",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff2: "font/woff2",
    woff: "font/woff",
    ttf: "font/ttf",
  };
  return mimes[ext] ?? "application/octet-stream";
}

function serveStatic(pathname: string): Response | null {
  const webRoot = getWebRoot();
  let filePath = resolve(webRoot, pathname.slice(1));

  if (!existsSync(filePath) || filePath.endsWith("/")) {
    filePath = resolve(webRoot, "index.html");
  }

  if (!existsSync(filePath)) {
    return null;
  }

  const content = readFileSync(filePath);
  return new Response(content, {
    headers: { "Content-Type": getMimeType(filePath) },
  });
}

function routeApi(pathname: string, url: URL): Promise<Response> | Response | null {
  const apiPrefix = "/api/";
  if (!pathname.startsWith(apiPrefix)) return null;

  const rest = pathname.slice(apiPrefix.length);
  const segments = rest.split("/").filter(Boolean);

  if (segments[0] === "queues" && segments.length === 1) {
    return handleQueuesList();
  }

  if (segments[0] === "queues" && segments[2] === "jobs" && segments.length === 3) {
    return handleJobsList(segments[1]!, url);
  }

  if (segments[0] === "queues" && segments[2] === "jobs" && segments.length === 4) {
    return handleJobDetail(segments[1]!, segments[3]!);
  }

  if (segments[0] === "queues" && segments[2] === "schedulers" && segments.length === 3) {
    return handleSchedulersList(segments[1]!);
  }

  if (segments[0] === "queues" && segments[2] === "schedulers" && segments.length === 4) {
    return handleSchedulerDetail(segments[1]!, segments[3]!);
  }

  if (segments[0] === "metrics" && segments.length === 1) {
    return handleMetrics();
  }

  return handleNotFound();
}

const FULL_SYNC_INTERVAL_MS = 60_000;

export async function startWebServer(): Promise<void> {
  const config = getConfig();

  await connectRedis();
  createSqliteDb();

  console.log("Starting initial SQLite sync...");
  fullSync().catch((err) => console.error("Initial sync failed:", err));

  setInterval(() => {
    fullSync().catch((err) => console.error("Periodic full sync failed:", err));
  }, FULL_SYNC_INTERVAL_MS);

  const server = Bun.serve({
    port: config.webPort,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname.startsWith("/api/")) {
        const result = routeApi(pathname, url);
        if (result) return result;
        return handleNotFound();
      }

      const staticResponse = serveStatic(pathname);
      if (staticResponse) return staticResponse;

      return handleNotFound();
    },
  });

  console.log(`bullmq-dash web dashboard running at http://localhost:${server.port}`);
}
