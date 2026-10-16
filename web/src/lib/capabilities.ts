/**
 * What this deployment can do, asked once at boot.
 *
 * One artifact ships as two editions (design, One Artifact, Two Profiles): the self-hosted one, which
 * has no accounts and takes a bucket the user attaches, and the hosted one, which is paired with
 * atelier central for sign-in, billing and provisioned storage. `ATELIER_PROFILE` picks which, and the
 * server states the answer at `/api/capabilities` rather than baking it into this build.
 *
 * The default below is the self-hosted answer, so the app behaves when there is no server to ask —
 * under `vite dev`, or if the request fails. Nothing here is a security boundary: a client can always
 * edit what it fetched. It decides what to draw, not what is allowed.
 */

import { writable } from "svelte/store";

export interface Central {
  /** Central's public base URL. */
  url: string;
  /** Where a browser signs in. Central returns to the cloud app from here. */
  login: string;
}

export interface Capabilities {
  profile: "standalone" | "hosted";
  /** Whether there is anywhere to sign in to. */
  accounts: boolean;
  /** The billing that takes the money, or `null` when nothing does. */
  billing: string | null;
  /** `attached`: the user brings a bucket. `provisioned`: the host gives each account one. */
  storage: "attached" | "provisioned";
  /** `null` in the self-hosted profile, which is the whole of what changes. */
  central: Central | null;
}

/** The self-hosted edition, which is the one that needs no server to describe it. */
export const STANDALONE: Capabilities = {
  profile: "standalone",
  accounts: false,
  billing: null,
  storage: "attached",
  central: null,
};

export const capabilities = writable<Capabilities>(STANDALONE);

/**
 * Whether the server has answered yet. The chrome waits for this before drawing anything that depends
 * on the profile, so a hosted deployment never flashes the self-hosted version of itself.
 */
export const capabilitiesReady = writable(false);

export async function loadCapabilities(): Promise<void> {
  try {
    const response = await fetch("/api/capabilities", {
      headers: { accept: "application/json" },
    });
    if (response.ok) {
      const body = (await response.json()) as Partial<Capabilities>;
      capabilities.set({ ...STANDALONE, ...body });
    }
  } catch {
    // No server, or not one that answers this, which is the standalone case the default describes.
  } finally {
    capabilitiesReady.set(true);
  }
}
