# Queue-data store is a TTL observation cache

## Context

The SQLite queue-data store now caches queues, jobs, and schedulers. The earlier soft-delete and reconciliation model tried to prove Redis absence and preserve historical jobs past Redis retention. The product direction changed: the store should be a bounded freshness cache of what bullmq-dash has observed, not a historical archive or a Redis mirror.

## Decision

1. **The store owns all cached dimensions.** Queues, jobs, and schedulers are read and written through the queue-data store public API.
2. **Observations never delete.** `recordObservedQueues`, `recordObservedJobs`, and `recordObservedSchedulers` upsert records and refresh `lastObservedAt`; records missing from an observation are not treated as removed.
3. **TTL cleanup is the only removal path.** `expireStaleRecords` physically deletes rows older than `cacheTtlMs`. Reads return rows that are physically present; they do not apply TTL filtering themselves.
4. **No reconciliation surface.** The store does not expose `reconcileFromRedis`, `reconcileAll`, `syncQueue`, or `fullSync`. It does not stage Redis snapshots or enforce job resurrection invariants.
5. **Full job details are cached when observed.** Job rows store stable detail fields as columns and structured payloads as JSON text. A latest observation replaces the stored row shape; omitted optional detail fields are cleared.

## Considered Alternatives

- **Keep soft-delete/history retention**: rejected because the desired model is a freshness cache, not historical browsing past Redis retention.
- **Delete missing rows during complete observations**: rejected because observations should have one uniform meaning: "we saw these rows." Absence is not inferred.
- **Filter TTL at read time**: rejected so cleanup is the single expiry mechanism. This makes stale-row visibility depend on cleanup cadence, which is explicit and testable.

## Consequences

- Every cache table has `last_observed_at INTEGER NOT NULL`.
- The runtime config uses `cacheTtlMs` with a 24-hour default.
- Queue expiry cascades to scheduler rows for that queue, but not job rows; job observations can exist independently of queue-stat observations.
- Automatic cleanup is lifecycle-owned and best-effort; explicit `expireStaleRecords` throws on failure.
- ADR-0001 is superseded. Its `removed_at`, history view, and reconciliation semantics are legacy concepts, not active API.
