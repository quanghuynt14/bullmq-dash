<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { getJobDetail } from "$lib/api";
  import type { JobDetail } from "$lib/types";
  import JobStateBadge from "$lib/components/JobStateBadge.svelte";
  import JsonViewer from "$lib/components/JsonViewer.svelte";

  let queueName = $derived($page.params.name);
  let jobId = $derived($page.params.id);

  let job: JobDetail | null = $state(null);
  let loading = $state(true);
  let error = $state("");

  function formatTime(ts: number | undefined): string {
    if (!ts) return "—";
    return new Date(ts).toLocaleString();
  }

  onMount(async () => {
    try {
      const result = await getJobDetail(queueName, jobId);
      job = result.job;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load job";
    } finally {
      loading = false;
    }
  });
</script>

<div class="mb-4">
  <a href="/queues/{queueName}" class="text-sm text-blue hover:underline">&larr; Back to queue</a>
  <h2 class="text-xl font-bold mt-1">Job: {jobId}</h2>
</div>

{#if loading}
  <p class="text-overlay">Loading...</p>
{:else if error}
  <p class="text-red">{error}</p>
{:else if job}
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
    <div class="bg-mantle border border-surface rounded p-4">
      <h3 class="text-sm font-bold mb-2 uppercase text-overlay">Info</h3>
      <dl class="text-sm space-y-1">
        <div class="flex"><dt class="w-32 text-overlay">Name</dt><dd>{job.name}</dd></div>
        <div class="flex"><dt class="w-32 text-overlay">State</dt><dd><JobStateBadge state={job.state} /></dd></div>
        <div class="flex"><dt class="w-32 text-overlay">Attempts</dt><dd>{job.attemptsMade}</dd></div>
        <div class="flex"><dt class="w-32 text-overlay">Created</dt><dd>{formatTime(job.timestamp)}</dd></div>
        <div class="flex"><dt class="w-32 text-overlay">Processed</dt><dd>{formatTime(job.processedOn)}</dd></div>
        <div class="flex"><dt class="w-32 text-overlay">Finished</dt><dd>{formatTime(job.finishedOn)}</dd></div>
      </dl>
    </div>

    {#if job.failedReason}
    <div class="bg-mantle border border-surface rounded p-4">
      <h3 class="text-sm font-bold mb-2 uppercase text-red">Failed Reason</h3>
      <p class="text-sm text-red">{job.failedReason}</p>
      {#if job.stacktrace}
        <pre class="text-xs text-overlay mt-2 overflow-x-auto">{job.stacktrace.join("\n")}</pre>
      {/if}
    </div>
    {/if}
  </div>

  <div class="space-y-4">
    <div>
      <h3 class="text-sm font-bold mb-2 uppercase text-overlay">Data</h3>
      <JsonViewer data={job.data} />
    </div>

    {#if job.returnvalue}
    <div>
      <h3 class="text-sm font-bold mb-2 uppercase text-overlay">Return Value</h3>
      <JsonViewer data={job.returnvalue} collapsed={true} />
    </div>
    {/if}

    <div>
      <h3 class="text-sm font-bold mb-2 uppercase text-overlay">Options</h3>
      <JsonViewer data={job.opts} collapsed={true} />
    </div>
  </div>
{/if}
