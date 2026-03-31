<script lang="ts">
  let { value = $bindable("all") }: { value?: string } = $props();

  const states = ["all", "active", "waiting", "completed", "failed", "delayed"];
</script>

<div class="flex gap-1">
  {#each states as state}
    <button
      onclick={() => (value = state)}
      class="text-xs px-3 py-1 rounded transition-colors
        {value === state
          ? 'bg-blue text-crust font-bold'
          : 'bg-surface text-overlay hover:text-text'}"
    >
      {state}
    </button>
  {/each}
</div>
