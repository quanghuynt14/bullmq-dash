import { config } from "dotenv";
import { z } from "zod";

// Load .env file
config();

const configSchema = z.object({
  redis: z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().int().positive().default(6379),
    password: z.string().optional(),
    db: z.coerce.number().int().min(0).default(0),
  }),
  pollInterval: z.coerce.number().int().positive().default(3000),
  queueNames: z.array(z.string()).optional(),
});

export type Config = z.infer<typeof configSchema>;

export function parseQueueNames(value: string | undefined): string[] | undefined {
  if (!value || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const raw = {
    redis: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD || undefined,
      db: process.env.REDIS_DB,
    },
    pollInterval: process.env.POLL_INTERVAL,
    queueNames: parseQueueNames(process.env.QUEUE_NAMES),
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.flatten();
    console.error("Configuration error:");
    console.error(JSON.stringify(errors, null, 2));
    process.exit(1);
  }

  return result.data;
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
