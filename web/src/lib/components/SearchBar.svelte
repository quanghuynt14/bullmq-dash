<script lang="ts">
  let {
    value = $bindable(""),
    onSearch,
  }: { value?: string; onSearch: (q: string) => void } = $props();

  let timer: ReturnType<typeof setTimeout>;

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    value = target.value;
    clearTimeout(timer);
    timer = setTimeout(() => onSearch(value), 300);
  }
</script>

<input
  type="text"
  placeholder="Search jobs by name..."
  {value}
  oninput={handleInput}
  class="bg-mantle border border-surface rounded px-3 py-2 text-sm w-full focus:border-blue outline-none"
/>
