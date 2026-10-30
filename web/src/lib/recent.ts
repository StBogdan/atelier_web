/**
 * The document a workspace was last opened at, per workspace, in this browser.
 *
 * It is a convenience and nothing else: the pages fall back to the workspace's first document when
 * the name is missing, or when the document it names has since been renamed or removed. Storage can
 * refuse to answer, which is why neither function throws.
 */

const KEY = "atelier-cloud:opened:";

export function lastOpened(project: string): string | null {
  try {
    return localStorage.getItem(`${KEY}${project}`);
  } catch {
    return null;
  }
}

export function rememberOpened(project: string, document: string): void {
  try {
    localStorage.setItem(`${KEY}${project}`, document);
  } catch {
    // A browser that refuses storage is not a reason to refuse the open.
  }
}
