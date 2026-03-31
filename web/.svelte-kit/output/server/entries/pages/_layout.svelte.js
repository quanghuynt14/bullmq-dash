import "clsx";
function _layout($$renderer, $$props) {
  let { children } = $$props;
  $$renderer.push(`<div class="min-h-screen bg-base text-text"><header class="border-b border-surface px-4 py-2 flex items-center justify-between"><h1 class="text-lg font-bold text-blue">bullmq-dash</h1> <nav class="text-sm text-subtext"><a href="/" class="hover:text-text">Dashboard</a></nav></header> <main class="p-4">`);
  children($$renderer);
  $$renderer.push(`<!----></main> <footer class="border-t border-surface px-4 py-2 text-xs text-overlay">bullmq-dash v0.1.0</footer></div>`);
}
export {
  _layout as default
};
