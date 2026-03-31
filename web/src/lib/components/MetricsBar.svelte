<script lang="ts">
  import type { GlobalMetrics } from "$lib/types";

  let { metrics }: { metrics: GlobalMetrics | null } = $props();
</script>

{#if metrics}
<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 mb-4">
  <div class="bg-mantle border border-surface rounded p-3 text-center">
    <div class="text-xs text-overlay uppercase">Queues</div>
    <div class="text-xl font-bold">{metrics.queueCount}</div>
  </div>
  <div class="bg-mantle border border-surface rounded p-3 text-center">
    <div class="text-xs text-yellow uppercase">Waiting</div>
    <div class="text-xl font-bold text-yellow">{metrics.jobCounts.wait}</div>
  </div>
  <div class="bg-mantle border border-surface rounded p-3 text-center">
    <div class="text-xs text-green uppercase">Active</div>
    <div class="text-xl font-bold text-green">{metrics.jobCounts.active}</div>
  </div>
  <div class="bg-mantle border border-surface rounded p-3 text-center">
    <div class="text-xs text-blue uppercase">Completed</div>
    <div class="text-xl font-bold text-blue">{metrics.jobCounts.completed}</div>
  </div>
  <div class="bg-mantle border border-surface rounded p-3 text-center">
    <div class="text-xs text-red uppercase">Failed</div>
    <div class="text-xl font-bold text-red">{metrics.jobCounts.failed}</div>
  </div>
  <div class="bg-mantle border border-surface rounded p-3 text-center">
    <div class="text-xs text-mauve uppercase">Delayed</div>
    <div class="text-xl font-bold text-mauve">{metrics.jobCounts.delayed}</div>
  </div>
  <div class="bg-mantle border border-surface rounded p-3 text-center">
    <div class="text-xs text-overlay uppercase">Enq/Min</div>
    <div class="text-xl font-bold">{metrics.rates.enqueuedPerMin.toFixed(0)}</div>
  </div>
</div>
{/if}
