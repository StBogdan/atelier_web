import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// The design's routes are /cloud/, /cloud/workspace/<id> and /cloud/settings (6.1), and the
		// front door serves the build at /cloud/ (2.2). Project ids are not known at build time, so
		// this is one static page: an SPA with a fallback, not a prerendered route per workspace.
		paths: { base: '/cloud' },
		adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', precompress: false, strict: false })
	}
};

export default config;
