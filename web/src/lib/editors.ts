/**
 * The editors this cloudspace can open a document in. A document's extension decides which apply;
 * the only thing remembered per workspace is a default for one that holds no document yet.
 *
 * Each editor is served from this origin, under its own path, so it shares one OPFS with the cloud
 * app. The path is absolute and ends in a slash, which is what the builds' relative asset URLs need.
 */

import { base } from "$app/paths";
import { extensionOf } from "./format";

export type EditorId = "photocraft" | "pdfcraft";

export interface Editor {
  id: EditorId;
  title: string;
  /** Where this origin serves it. Always ends in `/`. */
  route: string;
  /** How a workspace is opened: its own tab, or a cloud page around an embedded editor. */
  launch: "tab" | "embed";
  /** The file a bare workspace suggests, and the extension a save uses. */
  defaultDocument: string;
  /** The extension, without the dot, that `defaultDocument` ends in. */
  extension: string;
  /** What a revision of this editor's document records. */
  revision: "objects" | "whole";
  /** Extensions this editor opens from a workspace. */
  opens: readonly string[];
  /** Extensions a workspace may be started from. */
  starts: readonly string[];
}

/**
 * What PhotoCraft's own importer reads. The picker's filter is a convenience: a document it cannot
 * read is still accepted, and the editor reports that itself when it opens.
 */
const PHOTOCRAFT_EXTENSIONS = [
  ".pcraft",
  ".psd",
  ".psb",
  ".psdt",
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".webp",
  ".gif",
  ".bmp",
  ".tga",
  ".ico",
  ".qoi",
  ".exr",
  ".hdr",
  ".svg",
  ".svgz",
  ".ora",
  ".kra",
  ".krz",
  ".pdn",
  ".dng",
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".raf",
] as const;

export const EDITORS: readonly Editor[] = [
  {
    id: "photocraft",
    title: "PhotoCraft",
    route: "/photocraft/",
    launch: "tab",
    defaultDocument: "doc.pcraft",
    extension: "pcraft",
    revision: "objects",
    opens: PHOTOCRAFT_EXTENSIONS,
    starts: PHOTOCRAFT_EXTENSIONS,
  },
  {
    id: "pdfcraft",
    title: "PdfCraft",
    route: "/pdfcraft/",
    launch: "embed",
    defaultDocument: "doc.pdf",
    extension: "pdf",
    revision: "whole",
    opens: [
      ".pdf",
      ".png",
      ".jpg",
      ".jpeg",
      ".tif",
      ".tiff",
      ".gif",
      ".bmp",
      ".jp2",
      ".j2k",
      ".jpx",
      ".txt",
      ".text",
    ],
    starts: [".pdf"],
  },
];

export const DEFAULT_EDITOR: Editor = EDITORS[0];

export function editorById(id: string | null | undefined): Editor | undefined {
  return EDITORS.find((editor) => editor.id === id);
}

/** Every editor that claims this document, in registry order. */
export function editorsFor(name: string | null | undefined): Editor[] {
  if (!name) return [];
  const extension = extensionOf(name).toLowerCase();
  return EDITORS.filter((editor) => editor.opens.includes(extension));
}

/**
 * The editor a document opens in. Its extension decides; a workspace's recorded default only breaks
 * a tie or covers a document no editor claims.
 */
export function editorFor(
  name: string | null | undefined,
  preferred?: string | null,
): Editor {
  const matching = editorsFor(name);
  const wanted = editorById(preferred);
  if (matching.length)
    return wanted && matching.includes(wanted) ? wanted : matching[0];
  return wanted ?? DEFAULT_EDITOR;
}

/**
 * Where a workspace or one of its documents opens. A tab editor takes the document in its own URL;
 * an embedded editor gets a page in the cloud app, which frames it and speaks its bridge.
 */
export function editorHref(
  editor: Editor,
  project: string,
  document?: string,
): string {
  if (editor.launch === "embed")
    return `${base}/workspace/${encodeURIComponent(project)}/edit/${editor.id}${
      document ? `?document=${encodeURIComponent(document)}` : ""
    }`;
  return `${editor.route}?project=${encodeURIComponent(project)}${
    document ? `&document=${encodeURIComponent(document)}` : ""
  }`;
}
