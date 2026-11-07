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
    // The launcher links to `/blog/`, which is the site's articles rather than this app: they are
    // rendered from `content/blog/` by `scripts/blog.mjs` and served beside the landing page. The
    // crawler that follows links during prerendering has no such route here, so the link is
    // recognised and left alone; every other broken link still fails the build.
    prerender: {
      handleHttpError: ({ path, message }) => {
        if (path === "/blog" || path.startsWith("/blog/")) return;
        throw new Error(message);
      },
    },
  },
};

export default config;
