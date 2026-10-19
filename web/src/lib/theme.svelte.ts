/**
 * Light or dark, chosen here: the switch in the app bar writes the choice down, and the next visit
 * starts in the same theme. Until someone chooses, the page follows the operating system, and keeps
 * following it while it changes.
 *
 * The first paint is decided by the small script in `app.html`, before this module runs; this keeps
 * the state in step with the attribute that script already set.
 */
import { browser } from "$app/environment";

const KEY = "atelier-cloud:theme";
const LIGHT_CHROME = "#2f6feb";
const DARK_CHROME = "#282828";

export type Theme = "light" | "dark";

export const theme = $state<{ current: Theme }>({ current: "light" });

let started = false;

function stored(): Theme | null {
  if (!browser) return null;
  const value = localStorage.getItem(KEY);
  return value === "light" || value === "dark" ? value : null;
}

function system(): Theme {
  if (!browser) return "light";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(next: Theme) {
  theme.current = next;
  if (!browser) return;
  document.documentElement.dataset.theme = next;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", next === "dark" ? DARK_CHROME : LIGHT_CHROME);
}

/** Take the theme the page already rendered with, then follow the system while no choice is stored. */
export function startTheme() {
  if (!browser || started) return;
  started = true;
  theme.current = stored() ?? system();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!stored()) apply(system());
  });
}

/** The switch: the opposite of what is on screen, written down so it outlives the visit. */
export function toggleTheme() {
  const next: Theme = theme.current === "dark" ? "light" : "dark";
  if (browser) localStorage.setItem(KEY, next);
  apply(next);
}
