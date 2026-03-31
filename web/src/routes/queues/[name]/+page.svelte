<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/stores";
  import { getJobs } from "$lib/api";
  import type { JobRow } from "$lib/types";
  import SearchBar from "$lib/components/SearchBar.svelte";
  import StateFilter from "$lib/components/StateFilter.svelte";
  import JobTable from "$lib/components/JobTable.svelte";
  import Pagination from "$lib/components/Pagination.svelte";

  let queueName = $derived($page.params.name);

  let jobs: JobRow[] = $state([]);
  let total = $state(0);
  let loading = $state(true);

  let search = $state("");
  let state = $state("all");
  let sort = $state("timestamp");
  let order = $state("desc");
  let page_num = $state(1);
  let pageSize = $state(25);

  let totalPages = $derived(Math.ceil(total / pageSize));
  let interval: ReturnType<typeof setInterval>;

  async function fetchData() {
    loading = true;
    try {
      const result = await getJobs(queueName, {
        q: search,
        state,
        sort,
        order,
        page: page_num,
        pageSize,
      });
      jobs = result.jobs;
      total = result.total;
    } catch (e) {
      console.error("Failed to fetch jobs", e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    search;
    state;
    sort;
    order;
    page_num = 1;
  });

  $effect(() => {
    queueName;
    search;
    state;
    sort;
    order;
    page_num;
    pageSize;
    fetchData();
  });

  onMount(() => {
    interval = setInterval(fetchData, 5000);
  });

  onDestroy(() => {
    clearInterval(interval);
  });
</script>

<div class="mb-4">
  <a href="/" class="text-sm text-blue hover:underline">&larr; Back to dashboard</a>
  <h2 class="text-xl font-bold mt-1">Queue: {queueName}</h2>
</div>

<div class="flex flex-col md:flex-row gap-3 mb-4">
  <div class="flex-1">
    <SearchBar bind:value={search} onSearch={(q) => (search = q)} />
  </div>
  <StateFilter bind:value={state} />
</div>

{#if loading}
  <p class="text-overlay">Loading...</p>
{:else}
  <JobTable bind:jobs bind:sort bind:order {queueName} />
  <Pagination bind:page={page_num} {totalPages} {total} />
{/if}
