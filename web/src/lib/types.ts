export interface QueueStats {
  name: string;
  counts: {
    wait: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    schedulers: number;
  };
  isPaused: boolean;
  total: number;
}

export interface JobRow {
  id: string;
  queue: string;
  name: string;
  state: string;
  timestamp: number;
  data_preview: string | null;
}

export interface JobDetail {
  id: string;
  name: string;
  state: string;
  timestamp: number;
  data: unknown;
  opts: unknown;
  attemptsMade: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: unknown;
  processedOn?: number;
  finishedOn?: number;
  progress?: number | object;
}

export interface GlobalMetrics {
  queueCount: number;
  jobCounts: {
    wait: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    total: number;
  };
  rates: {
    enqueuedPerMin: number;
    dequeuedPerMin: number;
  };
}

export interface Scheduler {
  key: string;
  name: string;
  pattern?: string;
  every?: number;
  next?: number;
  iterationCount?: number;
  tz?: string;
}
