<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { getSchedulers } from "$lib/api";
  import type { Scheduler } from "$lib/types";

  let queueName = $derived($page.params.name);
  let schedulers: Scheduler[] = $state([]);
  let loading = $state(true);

  onMount(async () => {
    try {
      const data = await getSchedulers(queueName);
      schedulers = data.schedulers;
    } catch (e) {
      console.error("Failed to fetch schedulers", e);
    } finally {
      loading = false;
    }
  });

  function formatSchedule(s: Scheduler): string {
    if (s.pattern) return s.pattern;
    if (s.every) return `every ${s.every}ms`;
    return "—";
  }

  function formatNextRun(next: number | undefined): string {
    if (!next) return "—";
    const diff = next - Date.now();
    if (diff < 0) return "overdue";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }
</script>

<div class="mb-4">
  <a href="/queues/{queueName}" class="text-sm text-blue hover:underline"
    >&larr; Back to queue</a
  >
  <h2 class="text-xl font-bold mt-1">Schedulers: {queueName}</h2>
</div>

{#if loading}
  <p class="text-overlay">Loading...</p>
{:else if schedulers.length === 0}
  <p class="text-overlay">No schedulers found</p>
{:else}
  <table class="w-full text-sm">
    <thead>
      <tr
        class="border-b border-surface text-left text-overlay uppercase text-xs"
      >
        <th class="px-3 py-2">Key</th>
        <th class="px-3 py-2">Name</th>
        <th class="px-3 py-2">Schedule</th>
        <th class="px-3 py-2">Next Run</th>
        <th class="px-3 py-2">Iterations</th>
        <th class="px-3 py-2">TZ</th>
      </tr>
    </thead>
    <tbody>
      {#each schedulers as s (s.key)}
        <tr class="border-b border-surface/50 hover:bg-surface/30">
          <td class="px-3 py-2 text-blue">{s.key}</td>
          <td class="px-3 py-2">{s.name}</td>
          <td class="px-3 py-2 text-mauve">{formatSchedule(s)}</td>
          <td class="px-3 py-2">{formatNextRun(s.next)}</td>
          <td class="px-3 py-2 text-overlay">{s.iterationCount ?? "—"}</td>
          <td class="px-3 py-2 text-overlay">{s.tz ?? "—"}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
