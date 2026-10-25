/**
 * What this deployment is made of: the commit the cloud build came from, and the version of each editor
 * it hosts. The server asks each editor's host for the provenance file its build wrote, so this is what
 * is being served now rather than what was configured when the server started.
 *
 * A deployment that answers neither question is not an error: the settings page says "unknown" rather
 * than inventing a value. Nothing here decides what the app may do.
 */

export interface HostedEditor {
  id: string;
  title: string;
  /** Whether this deployment serves the editor at all. */
  hosted: boolean;
  /** The version its build published, when it published one. */
  version: string | null;
  /** The commit its build published, when it published one. */
  commit: string | null;
}

export interface BuildVersion {
  /** `atelier-web` for this server. */
  service: string;
  /** The commit the cloud build came from, or `null` when nothing recorded it. */
  commit: string | null;
  editors: HostedEditor[];
}

/**
 * `null` when there is no server to ask: under `vite dev` without Atelier web, or if the request fails.
 * The page treats that as the same state as a build that recorded nothing.
 */
export async function loadVersion(): Promise<BuildVersion | null> {
  try {
    const response = await fetch("/api/version", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as BuildVersion;
  } catch {
    return null;
  }
}

/** A SHA, with the `-dirty` a build from an uncommitted tree carries. */
const SHA = /^([0-9a-f]{7,40})(-dirty)?$/i;

/**
 * A commit as the page shows it: short enough to read, long enough to look up. A working tree's `-dirty`
 * survives, because it is the part that says the commit does not describe what is deployed.
 */
export function shortCommit(commit: string | null | undefined): string {
  const match = SHA.exec(commit ?? "");
  if (!match) return commit || "unknown";
  return `${match[1].slice(0, 9)}${match[2] ?? ""}`;
}
