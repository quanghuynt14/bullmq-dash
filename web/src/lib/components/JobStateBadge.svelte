<script lang="ts">
  let { state }: { state: string } = $props();

  const colors: Record<string, string> = {
    active: "bg-green/20 text-green",
    waiting: "bg-yellow/20 text-yellow",
    completed: "bg-blue/20 text-blue",
    failed: "bg-red/20 text-red",
    delayed: "bg-mauve/20 text-mauve",
    prioritized: "bg-teal/20 text-teal",
  };
</script>

<span class="text-xs px-2 py-0.5 rounded {colors[state] ?? 'bg-surface text-overlay'}">
  {state}
</span>
