<script lang="ts">
  /**
   * A failure, drawn: the heading first, then its points, then wherever to go about it.
   *
   * The bucket's failures are read standing up, in a form, at the moment something the reader expected to
   * work did not — and the fix is usually a click, not a paragraph.
   */
  import { describeProblem } from "./problem";

  let {
    problem,
    banner = false,
    small = false,
  }: { problem: unknown; banner?: boolean; small?: boolean } = $props();
  const described = $derived(describeProblem(problem));
</script>

{#if described}
  <div class="problem" class:banner class:small>
    {#if described.heading}
      <p><strong>{described.heading}</strong></p>
    {/if}
    {#each described.points as point, index (index)}
      <p>{point}</p>
    {/each}
    {#if described.help}
      <p><a href={described.help.href}>{described.help.text}</a></p>
    {/if}
  </div>
{/if}

<style>
  .problem {
    color: var(--bad);
  }

  /* The quiet size the panels use beside a form; the banner keeps the page's own size. */
  .problem.small {
    font-size: 0.86rem;
  }

  /* A banner's own left rule is the warning colour; a failure's is the failure colour. */
  .problem.banner {
    border-left-color: var(--bad);
  }

  .problem p {
    margin: 0 0 0.3rem;
  }

  .problem p:last-child {
    margin-bottom: 0;
  }

  .problem a {
    color: inherit;
  }
</style>
