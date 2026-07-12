// Continuous BullMQ traffic for the demo recording: producers add jobs at a
// modest rate and deliberately slow workers keep some jobs ACTIVE, so the TUI
// shows live movement (ACTIVE > 0, ENQ/DEQ rates, DONE climbing). A slice of
// payments jobs fail to keep the failed-triage story alive. Runs until killed.
import { Queue, Worker } from "bullmq";

const connection = { host: "127.0.0.1", port: 6379 };

interface Traffic {
  queue: string;
  jobName: string;
  data: () => Record<string, unknown>;
  addEveryMs: number;
  processMs: [number, number];
  concurrency: number;
  failRate: number;
  failMessage: string;
}

const traffic: Traffic[] = [
  {
    queue: "payments",
    jobName: "charge-card",
    data: () => ({
      orderId: `ord_${6000 + Math.floor(Math.random() * 999)}`,
      amountCents: 900 + Math.floor(Math.random() * 9000),
      currency: "eur",
    }),
    addEveryMs: 350,
    processMs: [400, 1600],
    concurrency: 3,
    failRate: 0.08,
    failMessage: "Stripe API error: card_declined (insufficient_funds)",
  },
  {
    queue: "notifications",
    jobName: "push-notification",
    data: () => ({
      userId: 3000 + Math.floor(Math.random() * 500),
      channel: Math.random() < 0.3 ? "sms" : "push",
    }),
    addEveryMs: 200,
    processMs: [200, 900],
    concurrency: 4,
    failRate: 0,
    failMessage: "",
  },
  {
    queue: "email",
    jobName: "send-welcome-email",
    data: () => ({
      to: `user${1000 + Math.floor(Math.random() * 999)}@example.com`,
      template: "welcome",
    }),
    addEveryMs: 550,
    processMs: [300, 1200],
    concurrency: 2,
    failRate: 0,
    failMessage: "",
  },
  {
    queue: "image-resize",
    jobName: "resize-thumbnail",
    data: () => ({
      key: `uploads/photo-${Math.floor(Math.random() * 9999)}.jpg`,
      sizes: [128, 512],
    }),
    addEveryMs: 900,
    processMs: [800, 2500],
    concurrency: 2,
    failRate: 0,
    failMessage: "",
  },
];

const rand = ([min, max]: [number, number]) => min + Math.random() * (max - min);

// Demo failures carry a clean, production-looking stack instead of leaking
// local scratchpad paths into the recorded GIF.
function demoError(message: string, queue: string): Error {
  const error = new Error(message);
  error.stack = [
    `Error: ${message}`,
    `    at StripeClient.charge (/app/src/payments/stripe-client.ts:142:15)`,
    `    at process${queue.replace(/[^a-z]/gi, "")}Job (/app/src/workers/${queue}.worker.ts:37:9)`,
    `    at async Worker.processJob (/app/node_modules/bullmq/dist/cjs/classes/worker.js:589:43)`,
  ].join("\n");
  return error;
}

for (const t of traffic) {
  const queue = new Queue(t.queue, { connection });
  setInterval(() => {
    queue.add(t.jobName, t.data()).catch(() => {});
  }, t.addEveryMs);

  new Worker(
    t.queue,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, rand(t.processMs)));
      if (Math.random() < t.failRate) throw demoError(t.failMessage, t.queue);
      return { ok: true };
    },
    { connection, concurrency: t.concurrency },
  );
}

console.log("live traffic running — kill to stop");
