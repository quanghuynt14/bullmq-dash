<script lang="ts">
  let {
    page = $bindable(1),
    totalPages,
    total,
  }: { page?: number; totalPages: number; total: number } = $props();

  const visiblePages = $derived.by(() => {
    const pages: number[] = [];
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  });
</script>

<div class="flex items-center justify-between text-sm mt-2">
  <span class="text-overlay">{total} jobs</span>
  <div class="flex items-center gap-1">
    <button
      onclick={() => (page = Math.max(1, page - 1))}
      disabled={page <= 1}
      class="px-2 py-1 rounded bg-surface disabled:opacity-50 hover:text-text"
    >
      prev
    </button>
    {#each visiblePages as p}
      <button
        onclick={() => (page = p)}
        class="px-2 py-1 rounded {p === page
          ? 'bg-blue text-crust'
          : 'bg-surface hover:text-text'}"
      >
        {p}
      </button>
    {/each}
    <button
      onclick={() => (page = Math.min(totalPages, page + 1))}
      disabled={page >= totalPages}
      class="px-2 py-1 rounded bg-surface disabled:opacity-50 hover:text-text"
    >
      next
    </button>
  </div>
</div>
