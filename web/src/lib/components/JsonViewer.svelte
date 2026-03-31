<script lang="ts">
  let { data, collapsed = false }: { data: unknown; collapsed?: boolean } = $props();
  let isCollapsed = $state(collapsed);

  let formatted = $derived.by(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  });
</script>

{#if data === undefined || data === null}
  <span class="text-overlay italic">null</span>
{:else}
  <div class="bg-crust border border-surface rounded">
    <button
      onclick={() => (isCollapsed = !isCollapsed)}
      class="text-xs px-3 py-1 text-overlay hover:text-text w-full text-left"
    >
      {isCollapsed ? "▶ expand" : "▼ collapse"}
    </button>
    {#if !isCollapsed}
      <pre class="p-3 text-sm overflow-x-auto text-green">{formatted()}</pre>
    {/if}
  </div>
{/if}
