<script lang="ts">
  /**
   * The glyphs a workspace row's actions use: an arrow leaving, and an arrow arriving in, a tray; a seal
   * around a check; the way into the editor; and the bucket a workspace may be attached to. Drawn here
   * rather than taken from an icon set, so the app stays dependent on nothing but itself.
   */
  let {
    name,
    size = 15,
  }: {
    name: "upload" | "download" | "commit" | "edit" | "bucket";
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
    // A recorded version: a seal around a check. Used when there is no bucket to send it to.
    commit: ["M21 12a9 9 0 1 1-9-9", "M8.4 12.2l2.7 2.7 4.9-5.1"],
    // Opening a workspace in the editor: a pencil, which still reads as "edit" at this size.
    edit: [
      "M4.8 19.2l1.3-4.6L15.7 5.1a2.7 2.7 0 0 1 3.8 3.8L9.9 18.4l-4.6 1.3z",
    ],
    // Somewhere to send a copy: a cloud, since that is what a bucket is from here. On the row's own
    // status line, where a pail read as a bin.
    bucket: [
      "M6.8 18.8H18A4.4 4.4 0 0 0 17.4 10.4A6.2 6.2 0 0 0 6.9 9.6A4.5 4.5 0 0 0 6.8 18.8Z",
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
