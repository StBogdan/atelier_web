import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // The design's routes are /cloud/, /cloud/workspace/<id> and /cloud/settings (6.1), and the
    // Atelier web serves the build at /cloud/ (2.2). The launcher, help and settings are prerendered,
    // so `/cloud/` is `index.html` and the two others are `help.html` and `settings.html`. Project ids
    // are not known at build time, so the workspace route is client-rendered and serves `200.html`
    // (the server sends only that prefix there, so an unknown path still answers 404).
    //
    // Absolute asset paths, not the default relative ones: a client-rendered route such as
    // `/cloud/workspace/<id>` is served from the fallback at an unknown depth, and `./_app/…` there
    // resolves inside the route rather than beside it.
    paths: { base: "/cloud", relative: false },
    adapter: adapter({
      pages: "build",
      assets: "build",
      fallback: "200.html",
      precompress: false,
      strict: false,
    }),
  },
};

export default config;
