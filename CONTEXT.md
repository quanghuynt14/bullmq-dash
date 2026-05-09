# bullmq-dash

A terminal dashboard ("kubectl for BullMQ") that observes BullMQ queues in Redis and presents them through an interactive TUI and a headless JSON CLI.

## Language

**Queue**:
A BullMQ queue identified by name; the unit a user navigates between in the dashboard.

**Job**:
A single BullMQ work item belonging to one **Queue**, identified by `(queue, id)`.

**Job state**:
The lifecycle stage of a **Job**: `waiting`, `active`, `completed`, `failed`, `delayed`, `prioritized`. Used for filtering and counting.
_Avoid_: status (overloaded with HTTP / process semantics).

**Queue-data store**:
The local SQLite-backed cache of observed **Queues**, **Jobs**, and **Schedulers**. Cache-primary: read paths always query the store; Redis is reached only by writers (polling, JSON reporter, reconciliation).

**Observation**:
A write event recording what was just seen in Redis. Two flavors:

- _Rich observation_ — full **Job** record (name, timestamp, data preview); produced by polling and the JSON reporter.
- _Thin observation_ — id + state only; produced by reconciliation when paginating millions of IDs.

**Reconciliation**:
The background pass that brings the **Queue-data store** up-to-date with the current Redis snapshot for every **Queue**. Inserts new **Jobs**, updates **Job state**, and soft-deletes **Jobs** that are no longer in Redis.

**Soft delete**:
Marking a **Job** in the **Queue-data store** as no-longer-present-in-Redis (`removed_at` timestamp), instead of dropping the row. Enables historical browsing past Redis retention.

**Retention window**:
The duration after **Soft delete** during which a **Job** remains in the **Queue-data store** before compaction physically removes it.

**Compaction**:
The pass that physically deletes soft-deleted **Jobs** older than the **Retention window**.

**Recently-polled coordination**:
Internal mechanism that prevents background **Reconciliation** from clobbering fresh **Rich observations** taken since reconciliation started. Private to the **Queue-data store**.

**TUI mode**:
The interactive terminal UI started by `--tui`. Foreground polling refreshes the visible **Queue**'s **Jobs**; background reconciliation refreshes everything.

**Headless mode**:
One-shot subcommand invocation (`bullmq-dash queues list`, `jobs list`, etc.) that prints JSON to stdout and exits. Designed for AI agents and scripts.

**Profile**:
A named connection configuration loaded from disk by the `--profile` flag.

## Relationships

- A **Queue** has zero or more **Jobs**.
- A **Job** has exactly one **Job state** at any moment.
- The **Queue-data store** receives **Observations** (rich and thin) from multiple writers and answers all reads.
- **Reconciliation** produces thin **Observations** for every **Job** in a **Queue**; **TUI mode** polling and **Headless mode** writers produce rich **Observations** for the subset of **Jobs** they fetch.
- A **Job** removed from Redis transitions to **Soft delete** at next **Reconciliation**, then is physically removed by **Compaction** after the **Retention window**.

## Example dialogue

> **User**: "Why is sync deleting jobs out from under the historical view?"
> **Maintainer**: "Today **Reconciliation** hard-deletes any **Job** missing from Redis. We're moving it to **Soft delete** so the **Queue-data store** keeps the row until the **Retention window** elapses, at which point **Compaction** removes it."
