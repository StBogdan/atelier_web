/**
 * What the pages share: the scanned catalog, storage health, and the watchers that keep the view
 * honest while the editor has a document open in another tab.
 *
 * The provider re-reads OPFS rather than trusting anything it saw before (design, How the Two Sides Communicate). The
 * editor's `BroadcastChannel` ping and this tab's focus events only decide *when* to re-read.
 */

import { writable, get } from "svelte/store";
import {
  commit,
  ensureSpace,
  requestPersistence,
  scan,
  storage as storageHealth,
  type Storage,
  type Workspace,
} from "./contract";
import { SPACE, type Directory } from "./opfs";

export const workspaces = writable<Workspace[]>([]);
export const storage = writable<Storage>({
  supported: null,
  usage: 0,
  quota: 0,
  persisted: false,
  asked: true,
});
export const ready = writable(false);
export const failure = writable<string | null>(null);

/**
 * A save becomes a version as soon as the provider looks: the editor announces every save, this page
 * re-reads on that ping, and whatever has moved since the last version is recorded on the way. The
 * list is read again after recording, so a card shows the version that exists rather than the one it
 * was about to become.
 */
async function recordSaves(space: Directory): Promise<Workspace[]> {
  const list = await scan(space);
  const moved = list.filter((workspace) => workspace.dirty);
  if (!moved.length) return list;
  for (const workspace of moved) {
    await commit(space, workspace.id).catch(() => {
      // What cannot be recorded yet keeps its own badge, and the next look tries again.
    });
  }
  return await scan(space);
}

/** Re-read the cloudspace, record any save it has not seen, and refresh what the chrome shows. */
export async function refresh(): Promise<void> {
  try {
    const space = await ensureSpace();
    workspaces.set(await recordSaves(space));
    storage.set(await storageHealth());
    failure.set(null);
  } catch (e) {
    failure.set(e instanceof Error ? e.message : String(e));
  } finally {
    ready.set(true);
  }
}

/** The editor's `BroadcastChannel` ping (design, How the Two Sides Communicate): a reason to re-read sooner, never the truth. */
const CHANNEL = SPACE;

let watching = false;

export function watch(): () => void {
  if (watching || typeof window === "undefined") return () => {};
  watching = true;

  const onFocus = () => void refresh();
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);

  let channel: BroadcastChannel | null = null;
  if ("BroadcastChannel" in window) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "document-saved") void refresh();
    };
  }

  // A slow sweep, so a long-lived tab in the foreground still notices a change (design, How the Two Sides Communicate).
  const timer = window.setInterval(() => void refresh(), 15_000);

  return () => {
    watching = false;
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
    window.clearInterval(timer);
    channel?.close();
  };
}

/**
 * Ask the browser to keep this origin's storage, the first time a visitor does something that
 * matters (design, Design Rules). Creating or opening a workspace counts; a bare look at the landing page
 * does not, so the prompt arrives when there is something to lose.
 */
export async function ensurePersistence(): Promise<void> {
  const current = get(storage);
  if (current.supported !== true || current.asked || current.persisted) return;
  await requestPersistence();
  storage.set(await storageHealth());
}
