import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // The design's routes are /workspaces/, /workspaces/<id> and /workspaces/settings (6.1), and the
    // Atelier web serves the build at /workspaces/ (2.2). The launcher, help and settings are
    // prerendered, so `/workspaces/` is `index.html` and the two others are `help.html` and
    // `settings.html`. Project ids are not known at build time, so `/workspaces/<id>` is the client-
    // rendered `[id]` route, served from `200.html`.
    //
    // Absolute asset paths, not the default relative ones: a client-rendered route such as
    // `/workspaces/<id>` is served from the fallback at an unknown depth, and `./_app/…` there
    // resolves inside the route rather than beside it.
    paths: { base: "/workspaces", relative: false },
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
