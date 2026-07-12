// Seed a local Redis with realistic BullMQ queues for the README demo GIF.
// Jobs are actually processed by workers so completed/failed states and
// stacktraces are real.
import { Queue, Worker } from "bullmq";

const connection = { host: "127.0.0.1", port: 6379 };

interface SeedSpec {
  queue: string;
  jobs: Array<{ name: string; data: Record<string, unknown>; fail?: string }>;
  waiting: Array<{ name: string; data: Record<string, unknown> }>;
  delayed?: Array<{ name: string; data: Record<string, unknown>; delayMs: number }>;
}

function n(
  count: number,
  make: (i: number) => { name: string; data: Record<string, unknown>; fail?: string },
) {
  return Array.from({ length: count }, (_, i) => make(i));
}

const specs: SeedSpec[] = [
  {
    queue: "payments",
    jobs: [
      ...n(48, (i) => ({
        name: "charge-card",
        data: { orderId: `ord_${4200 + i}`, amountCents: 1900 + i * 250, currency: "eur" },
      })),
      ...n(6, (i) => ({
        name: "charge-card",
        data: {
          orderId: `ord_${9100 + i}`,
          amountCents: 4900,
          currency: "eur",
          customerId: `cus_${7743 + i}`,
        },
        fail: "Stripe API error: card_declined (insufficient_funds) for customer cus_7743",
      })),
      ...n(2, (i) => ({ name: "refund", data: { orderId: `ord_${3300 + i}`, amountCents: 990 } })),
    ],
    waiting: n(9, (i) => ({
      name: "charge-card",
      data: { orderId: `ord_${5600 + i}`, amountCents: 2400 },
    })),
    delayed: [{ name: "retry-charge", data: { orderId: "ord_9099" }, delayMs: 90 * 60_000 }],
  },
  {
    queue: "email",
    jobs: [
      ...n(34, (i) => ({
        name: "send-welcome-email",
        data: { to: `user${100 + i}@example.com`, template: "welcome" },
      })),
      ...n(3, (i) => ({
        name: "send-receipt",
        data: { to: `user${300 + i}@example.com`, template: "receipt", orderId: `ord_${4200 + i}` },
        fail: "SMTP connect ETIMEDOUT smtp.mailer.example.com:587",
      })),
    ],
    waiting: n(5, (i) => ({
      name: "send-welcome-email",
      data: { to: `user${800 + i}@example.com`, template: "welcome" },
    })),
  },
  {
    queue: "notifications",
    jobs: n(52, (i) => ({
      name: "push-notification",
      data: { userId: 1000 + i, channel: i % 3 === 0 ? "sms" : "push" },
    })),
    waiting: n(7, (i) => ({
      name: "push-notification",
      data: { userId: 2000 + i, channel: "push" },
    })),
  },
  {
    queue: "image-resize",
    jobs: [
      ...n(17, (i) => ({
        name: "resize-thumbnail",
        data: { key: `uploads/photo-${i}.jpg`, sizes: [128, 512] },
      })),
      ...n(2, (i) => ({
        name: "resize-thumbnail",
        data: { key: `uploads/broken-${i}.heic`, sizes: [128] },
        fail: "Unsupported image format: HEIC decoder not available",
      })),
    ],
    waiting: n(3, (i) => ({
      name: "resize-thumbnail",
      data: { key: `uploads/photo-${40 + i}.jpg`, sizes: [128] },
    })),
  },
  {
    queue: "webhooks",
    jobs: [
      ...n(23, (i) => ({
        name: "deliver-webhook",
        data: { url: "https://hooks.customer.example/orders", event: "order.paid", attempt: 1 },
      })),
      {
        name: "deliver-webhook",
        data: { url: "https://hooks.flaky.example/events", event: "order.paid", attempt: 3 },
        fail: "HTTP 503 from https://hooks.flaky.example/events after 3 attempts",
      },
    ],
    waiting: n(4, (i) => ({
      name: "deliver-webhook",
      data: { url: "https://hooks.customer.example/orders", event: "order.refunded" },
    })),
  },
];

async function seed(spec: SeedSpec): Promise<void> {
  const queue = new Queue(spec.queue, { connection });
  await queue.obliterate({ force: true }).catch(() => {});

  await Promise.all(spec.jobs.map((job) => queue.add(job.name, { ...job.data, __fail: job.fail })));

  const worker = new Worker(
    spec.queue,
    async (job) => {
      if (job.data.__fail) {
        // Clean, production-looking stack so the demo GIF doesn't leak
        // local scratchpad paths.
        const error = new Error(job.data.__fail as string);
        error.stack = [
          `Error: ${job.data.__fail}`,
          `    at process${spec.queue.replace(/[^a-z]/gi, "")}Job (/app/src/workers/${spec.queue}.worker.ts:42:11)`,
          `    at async Worker.processJob (/app/node_modules/bullmq/dist/cjs/classes/worker.js:589:43)`,
        ].join("\n");
        throw error;
      }
      return { ok: true };
    },
    { connection, concurrency: 16 },
  );

  const target = spec.jobs.length;
  for (;;) {
    const counts = await queue.getJobCounts("completed", "failed");
    if ((counts.completed ?? 0) + (counts.failed ?? 0) >= target) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await worker.close();

  await Promise.all(spec.waiting.map((job) => queue.add(job.name, job.data)));
  await Promise.all(
    (spec.delayed ?? []).map((job) => queue.add(job.name, job.data, { delay: job.delayMs })),
  );

  await queue.close();
  console.log(`seeded ${spec.queue}`);
}

for (const spec of specs) {
  await seed(spec);
}

// Schedulers (repeatable jobs) so the schedulers view has content.
const email = new Queue("email", { connection });
await email.upsertJobScheduler(
  "daily-digest",
  { pattern: "0 9 * * *" },
  {
    name: "send-digest",
    data: { template: "daily-digest" },
  },
);
await email.close();

const webhooks = new Queue("webhooks", { connection });
await webhooks.upsertJobScheduler(
  "retry-pending",
  { every: 300_000 },
  {
    name: "retry-pending-webhooks",
    data: { batch: 50 },
  },
);
await webhooks.close();

console.log("done");
process.exit(0);
