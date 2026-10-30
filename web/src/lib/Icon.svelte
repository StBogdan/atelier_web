<script lang="ts">
  /**
   * The glyphs the pages use: an arrow leaving, and an arrow arriving in, a tray; the way into the
   * editor; and the bucket a workspace may be attached to. Drawn here rather than taken from an icon
   * set, so the app stays dependent on nothing but itself.
   */
  let {
    name,
    size = 15,
  }: {
    name:
      | "upload"
      | "download"
      | "edit"
      | "bucket"
      | "info"
      | "warn"
      | "documents"
      | "moon"
      | "sun";
    size?: number;
  } = $props();

  const glyphs = {
    upload: [
      "M12 16V5",
      "M8 9l4-4 4 4",
      "M4.5 15.5v2A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-2",
    ],
    download: [
      "M12 5v11",
      "M8 12l4 4 4-4",
      "M4.5 15.5v2A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-2",
    ],
    // Opening a workspace in the editor: a pencil, which still reads as "edit" at this size.
    edit: [
      "M4.8 19.2l1.3-4.6L15.7 5.1a2.7 2.7 0 0 1 3.8 3.8L9.9 18.4l-4.6 1.3z",
    ],
    // Somewhere to send a copy: a cloud, since that is what a bucket is from here. On the row's own
    // status line, where a pail read as a bin.
    bucket: [
      "M6.8 18.8H18A4.4 4.4 0 0 0 17.4 10.4A6.2 6.2 0 0 0 6.9 9.6A4.5 4.5 0 0 0 6.8 18.8Z",
    ],
    // Two sheets, one behind the other: a set of documents to pick from, rather than one file.
    documents: [
      "M8.5 3.5h5.5l3.5 3.5v9a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 16V5a1.5 1.5 0 0 1 1.5-1.5Z",
      "M14 3.5V7h3.5",
      "M5 7.5v11A2 2 0 0 0 7 20.5h8",
    ],
    info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18", "M12 11v5", "M12 8h.01"],
    warn: ["M12 4 2.8 20h18.4L12 4Z", "M12 10v4", "M12 17h.01"],
    // The theme switch: the moon to go dark, the sun to come back.
    moon: ["M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"],
    sun: [
      "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10",
      "M12 2v2",
      "M12 20v2",
      "M4.9 4.9l1.4 1.4",
      "M17.7 17.7l1.4 1.4",
      "M2 12h2",
      "M20 12h2",
      "M4.9 19.1l1.4-1.4",
      "M17.7 6.3l1.4-1.4",
    ],
  };
</script>

<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#each glyphs[name] as d}<path {d} />{/each}
</svg>
