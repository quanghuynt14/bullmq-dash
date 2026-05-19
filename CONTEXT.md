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
The local SQLite-backed TTL cache of observed **Queues**, **Jobs**, and **Schedulers**. Store reads return last-observed records that are still physically present in SQLite; Redis is reached by observer paths such as polling and headless commands.

**Observation**:
A write event recording what was just seen in Redis. Observations upsert records and refresh `lastObservedAt`; they never delete records that were not observed in the same batch.

**Cache TTL**:
The shared freshness window for cached **Queues**, **Jobs**, and **Schedulers**. Rows older than this window are deleted by cleanup.

**Cleanup**:
The pass that physically deletes rows whose `lastObservedAt` is older than the **Cache TTL**. Cleanup, not reads, enforces expiry.

**TUI mode**:
The interactive terminal UI started by `--tui`. Foreground polling observes visible **Queues**, **Jobs**, and **Schedulers**; background cleanup expires stale cache rows.

**Headless mode**:
One-shot subcommand invocation (`bullmq-dash queues list`, `jobs list`, etc.) that prints JSON to stdout and exits. Designed for AI agents and scripts.

**Profile**:
A named connection configuration loaded from disk by the `--profile` flag.

## Relationships

- A **Queue** has zero or more **Jobs**.
- A **Job** has exactly one **Job state** at any moment.
- The **Queue-data store** receives **Observations** from multiple writers and answers cached reads.
- **TUI mode** polling and **Headless mode** commands produce **Observations** for the records they fetch.
- A cached row remains readable until **Cleanup** physically deletes it after the **Cache TTL**.

## Example dialogue

> **User**: "Why does the dashboard show an old scheduler?"
> **Maintainer**: "The **Queue-data store** is an observation cache. Observations never prove absence; **Cleanup** removes stale rows once their **Cache TTL** elapses."
