

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export const imports = ["_app/immutable/nodes/0.B2aro7x5.js","_app/immutable/chunks/Dqp8ESuM.js","_app/immutable/chunks/CTgyv38e.js","_app/immutable/chunks/CwfeQI_4.js"];
export const stylesheets = ["_app/immutable/assets/0.BSrKGAq7.css"];
export const fonts = [];
