export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set([]),
	mimeTypes: {},
	_: {
		client: {start:"_app/immutable/entry/start.BKOnTVEd.js",app:"_app/immutable/entry/app.Cq00vN8F.js",imports:["_app/immutable/entry/start.BKOnTVEd.js","_app/immutable/chunks/D-FYEnMz.js","_app/immutable/chunks/CTgyv38e.js","_app/immutable/chunks/kKzwVnem.js","_app/immutable/entry/app.Cq00vN8F.js","_app/immutable/chunks/CTgyv38e.js","_app/immutable/chunks/CToLMEh9.js","_app/immutable/chunks/Dqp8ESuM.js","_app/immutable/chunks/kKzwVnem.js","_app/immutable/chunks/CwfeQI_4.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js'))
		],
		remotes: {
			
		},
		routes: [
			
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();
