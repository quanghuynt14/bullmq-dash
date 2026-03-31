<script lang="ts">
  import type { QueueStats } from "$lib/types";

  let { queue }: { queue: QueueStats } = $props();
</script>

<a
  href="/queues/{queue.name}"
  class="block bg-mantle border border-surface rounded p-4 hover:border-blue transition-colors"
>
  <div class="flex items-center justify-between mb-2">
    <h3 class="font-bold text-lg">{queue.name}</h3>
    {#if queue.isPaused}
      <span class="text-xs bg-yellow/20 text-yellow px-2 py-0.5 rounded">PAUSED</span>
    {:else}
      <span class="text-xs bg-green/20 text-green px-2 py-0.5 rounded">ACTIVE</span>
    {/if}
  </div>
  <div class="grid grid-cols-3 gap-2 text-sm">
    <div>
      <span class="text-yellow">{queue.counts.wait}</span>
      <span class="text-overlay">wait</span>
    </div>
    <div>
      <span class="text-green">{queue.counts.active}</span>
      <span class="text-overlay">active</span>
    </div>
    <div>
      <span class="text-blue">{queue.counts.completed}</span>
      <span class="text-overlay">done</span>
    </div>
    <div>
      <span class="text-red">{queue.counts.failed}</span>
      <span class="text-overlay">failed</span>
    </div>
    <div>
      <span class="text-mauve">{queue.counts.delayed}</span>
      <span class="text-overlay">delayed</span>
    </div>
    <div class="text-overlay">total: {queue.total}</div>
  </div>
</a>
