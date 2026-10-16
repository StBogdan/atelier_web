/**
 * A failure with a shape, for the places one grey sentence is not enough.
 *
 * Signing and sending to a bucket fails in ways whose fix is a place to go rather than a sentence — a
 * CORS policy, a token's permissions — so those failures carry a heading, the points under it, and
 * somewhere to click. [`Problem.svelte`](./Problem.svelte) draws one.
 *
 * `message` is the same text as a single string, so anything that only logs an error, or hands it to a
 * caller that stringifies it, still says everything.
 */

export interface Help {
  /** An app path, `base` already in it: the renderer links it as it stands. */
  href: string;
  text: string;
}

export class Problem extends Error {
  readonly heading: string;
  readonly points: string[];
  readonly help: Help | null;

  constructor(heading: string, points: string[], help: Help | null = null) {
    super([heading, ...points].join("\n\n"));
    this.name = "Problem";
    this.heading = heading;
    this.points = points;
    this.help = help;
  }
}

export interface Described {
  heading: string | null;
  points: string[];
  help: Help | null;
}

/**
 * Anything thrown, as a heading and its points. A `Problem` is taken as it stands; anything else is one
 * point and no heading, which is what most failures deserve.
 */
export function describeProblem(thrown: unknown): Described | null {
  if (thrown === null || thrown === undefined || thrown === "") return null;
  if (thrown instanceof Problem) {
    return {
      heading: thrown.heading,
      points: thrown.points,
      help: thrown.help,
    };
  }
  const text = thrown instanceof Error ? thrown.message : String(thrown);
  return text ? { heading: null, points: [text], help: null } : null;
}
