<script lang="ts">
  import type { JobRow } from "$lib/types";
  import JobStateBadge from "./JobStateBadge.svelte";

  let {
    jobs,
    queueName,
    sort = $bindable("timestamp"),
    order = $bindable("desc"),
  }: {
    jobs: JobRow[];
    queueName: string;
    sort?: string;
    order?: string;
  } = $props();

  function toggleSort(col: string) {
    if (sort === col) {
      order = order === "asc" ? "desc" : "asc";
    } else {
      sort = col;
      order = "desc";
    }
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  const sortIndicator = (col: string) =>
    sort === col ? (order === "asc" ? " ▲" : " ▼") : "";
</script>

<div class="overflow-x-auto">
  <table class="w-full text-sm">
    <thead>
      <tr class="border-b border-surface text-left text-overlay uppercase text-xs">
        <th class="px-3 py-2 cursor-pointer hover:text-text" onclick={() => toggleSort("id")}>ID{sortIndicator("id")}</th>
        <th class="px-3 py-2 cursor-pointer hover:text-text" onclick={() => toggleSort("name")}>Name{sortIndicator("name")}</th>
        <th class="px-3 py-2 cursor-pointer hover:text-text" onclick={() => toggleSort("state")}>State{sortIndicator("state")}</th>
        <th class="px-3 py-2 cursor-pointer hover:text-text" onclick={() => toggleSort("timestamp")}>Created{sortIndicator("timestamp")}</th>
      </tr>
    </thead>
    <tbody>
      {#each jobs as job (job.id)}
        <tr class="border-b border-surface/50 hover:bg-surface/30 transition-colors">
          <td class="px-3 py-2">
            <a href="/queues/{queueName}/jobs/{job.id}" class="text-blue hover:underline">{job.id}</a>
          </td>
          <td class="px-3 py-2">{job.name}</td>
          <td class="px-3 py-2"><JobStateBadge state={job.state} /></td>
          <td class="px-3 py-2 text-overlay">{formatTime(job.timestamp)}</td>
        </tr>
      {:else}
        <tr>
          <td colspan="4" class="px-3 py-8 text-center text-overlay">No jobs found</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
