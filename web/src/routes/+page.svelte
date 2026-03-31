<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getQueues, getMetrics } from "$lib/api";
  import type { QueueStats, GlobalMetrics } from "$lib/types";
  import MetricsBar from "$lib/components/MetricsBar.svelte";
  import QueueCard from "$lib/components/QueueCard.svelte";

  let queues: QueueStats[] = $state([]);
  let metrics: GlobalMetrics | null = $state(null);
  let loading = $state(true);
  let interval: ReturnType<typeof setInterval>;

  async function fetchData() {
    try {
      const [q, m] = await Promise.all([getQueues(), getMetrics()]);
      queues = q.queues;
      metrics = m.metrics;
    } catch (e) {
      console.error("Failed to fetch dashboard data", e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    fetchData();
    interval = setInterval(fetchData, 3000);
  });

  onDestroy(() => {
    clearInterval(interval);
  });
</script>

<h2 class="text-xl font-bold mb-4">Dashboard</h2>

<MetricsBar {metrics} />

{#if loading}
  <p class="text-overlay">Loading...</p>
{:else if queues.length === 0}
  <p class="text-overlay">No queues found</p>
{:else}
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    {#each queues as queue (queue.name)}
      <QueueCard {queue} />
    {/each}
  </div>
{/if}
