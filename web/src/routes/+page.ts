// The launcher is the one page a crawler or a link preview sees before any JavaScript runs, so it is
// rendered and prerendered rather than left to the client. `ssr = false` in the root layout still
// governs `/workspaces/<id>`, whose id is not known at build time. Everything here reads OPFS, which
// happens in `onMount`, so the prerendered pass only draws the chrome and the empty state.
export const ssr = true;
export const prerender = true;
