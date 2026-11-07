// Renders `content/blog/*.md` into `static/blog/`, so a deploy ships plain HTML pages beside the
// landing page. SvelteKit copies `static/` into the build, and the server names each file as a route.
//
// The chrome comes from the landing page rather than a second copy of it: its `<style>`, its header
// and its footer are read out of `static/landing/index.html` and reused verbatim, so the blog cannot
// drift away from the front door. Only the article's own typography is added here.

import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  copyFile,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = join(root, "content/blog");
const landingFile = join(root, "static/landing/index.html");
const outDir = join(root, "static/blog");
const origin = "https://ateliercloud.eu";

function extract(source, pattern, what) {
  const match = source.match(pattern);
  if (!match)
    throw new Error(
      `landing/index.html has no ${what}; the blog template reads it from there`,
    );
  return match[0];
}

/// `width` and `height` on every picture, so the browser reserves the box before the bytes arrive
/// and the paragraph under it does not jump. The size comes from the file the page will fetch; a
/// picture that cannot be read is left as it is, since a missing image is a broken page either way.
async function sizeImages(html) {
  const sizes = new Map();
  for (const [, src] of html.matchAll(/<img[^>]*src="([^"]+)"/g)) {
    if (sizes.has(src)) continue;
    const file = join(contentDir, src.replace(/^\/blog\//, ""));
    try {
      const { width, height } = await sharp(file).metadata();
      sizes.set(src, { width, height });
    } catch {
      sizes.set(src, null);
    }
  }
  return html.replace(/<img([^>]*)>/g, (tag, attrs) => {
    const src = /src="([^"]+)"/.exec(attrs)?.[1];
    const size = src && sizes.get(src);
    if (!size) return tag;
    return `<img${attrs} width="${size.width}" height="${size.height}" loading="lazy" decoding="async">`;
  });
}

function frontmatter(text, file) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`${file} has no frontmatter`);
  // A list may be written on one line or wrapped over several by Prettier, so the brackets are
  // collapsed onto one line before the fields are read.
  const flat = match[1]
    .replace(/\[[\s\S]*?\]/g, (block) => block.replace(/\s*\n\s*/g, " "))
    .replace(/^(\w+):\s*\n\s*/gm, "$1: ");
  const fields = {};
  for (const line of flat.split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    else if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
    }
    fields[key] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

const landing = await readFile(landingFile, "utf8");
const style = extract(landing, /<style>[\s\S]*?<\/style>/, "<style> block");
const header = extract(
  landing,
  /<header class="bar">[\s\S]*?<\/header>/,
  "header bar",
);
const footer = extract(
  landing,
  /<footer id="credits">[\s\S]*?<\/footer>/,
  "footer",
);

const files = (await readdir(contentDir))
  .filter((name) => name.endsWith(".md"))
  .sort();
const posts = [];
for (const file of files) {
  const text = await readFile(join(contentDir, file), "utf8");
  const { fields, body } = frontmatter(text, file);
  const slug = fields.slug || file.replace(/\.md$/, "");
  const html = await sizeImages(
    marked
      .parse(body.replace(/^\s*#\s+.*\n/, ""))
      .replaceAll('src="./images/', 'src="/blog/images/')
      .replaceAll('href="./images/', 'href="/blog/images/'),
  );
  // The provenance line at the end of a post is written from these two, so a tutorial cannot be
  // published without saying when it was checked and against which build of the editor.
  for (const field of ["updated", "pdfcraft"]) {
    if (!fields[field])
      throw new Error(`${file} has no "${field}" in its frontmatter`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.updated)) {
    throw new Error(
      `${file}: "updated" is ${fields.updated}, not an ISO date (YYYY-MM-DD)`,
    );
  }
  posts.push({ ...fields, slug, html, keywords: fields.keywords ?? [] });
}
posts.sort((a, b) => a.slug.localeCompare(b.slug));

// Rebuilt from scratch on every run, so a post that was renamed or deleted does not leave a page
// behind for the sitemap to find.
await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "images"), { recursive: true });

const postCss = `
      /* The article itself: one column, a measure that stays readable, and images that never
         overflow it. Everything else is the landing page's own sheet. */
      .post { max-width: 46rem; padding: 2.5rem 1.25rem 4rem; margin: 0 auto; }
      .post h1 { font-size: clamp(1.9rem, 4vw, 2.5rem); line-height: 1.15; letter-spacing: -0.02em; margin: 0.6rem 0 1rem; }
      .post > article > p:first-of-type { font-size: 1.1rem; color: var(--dim); }
      .post h2 { font-size: 1.3rem; margin: 2.4rem 0 0.75rem; }
      .post p, .post li { line-height: 1.65; }
      .post ul { padding-left: 1.4rem; }
      .post li { margin: 0.5rem 0; }
      .post ol { list-style: none; padding-left: 2.2rem; counter-reset: step; }
      .post ol > li { position: relative; }
      .post ol > li::before {
        counter-increment: step; content: counter(step);
        position: absolute; left: -2.2rem; top: 0.05rem;
        width: 1.55rem; height: 1.55rem; border-radius: 999px;
        background: var(--accent); color: #fff;
        font-size: 0.8rem; font-weight: 700; display: grid; place-items: center;
      }
      .post img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: var(--radius-lg); margin: 1.25rem 0; }
      .post code { font-family: var(--mono); font-size: 0.9em; background: var(--strip); padding: 0.1em 0.35em; border-radius: var(--radius-sm); }
      .post strong { font-weight: 650; }
      .sample { margin: 3rem 0 0; padding: 1.35rem 1.5rem; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--band); }
      .sample p { margin: 0 0 1rem; color: var(--dim); }
      .sample-button {
        display: inline-block; padding: 0.7rem 1.15rem; border-radius: var(--radius);
        background: var(--accent); color: #fff; font-weight: 600; text-decoration: none;
        border: 1px solid transparent;
      }
      .sample-button:hover { filter: brightness(1.05); }
      .post-note { margin: 2.5rem 0 0; padding-top: 1rem; border-top: 1px solid var(--rule); color: var(--dim); font-size: 0.9rem; }
      .crumbs { font-size: 0.9rem; color: var(--dim); }
      .crumbs a { color: var(--link); text-decoration: none; }
      .more { margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
      .more h2 { font-size: 1.1rem; margin: 0 0 0.75rem; }
      .more ul { list-style: none; padding: 0; margin: 0; }
      .more li { margin: 0.6rem 0; }
      .more a { color: var(--link); text-decoration: none; font-weight: 600; }
      .index-list { list-style: none; padding: 0; margin: 2rem 0 0; }
      .index-list li { padding: 1.25rem 0; border-top: 1px solid var(--rule); }
      .index-list a { color: var(--link); text-decoration: none; font-size: 1.15rem; font-weight: 650; }
      .index-list p { margin: 0.4rem 0 0; color: var(--dim); }
`;

const quote = (value) => String(value).replace(/"/g, "&quot;");

function page({ title, description, canonical, jsonLd, main, keywords = [] }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${title}</title>
    <meta name="description" content="${quote(description)}" />
    ${keywords.length ? `<meta name="keywords" content="${quote(keywords.join(", "))}" />` : ""}
    <link rel="canonical" href="${origin}${canonical}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="icon" href="/landing/favicon.svg" type="image/svg+xml" />
    <meta name="theme-color" content="#2f6feb" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Atelier Cloud" />
    <meta property="og:locale" content="en" />
    <meta property="og:url" content="${origin}${canonical}" />
    <meta property="og:title" content="${quote(title)}" />
    <meta property="og:description" content="${quote(description)}" />
    <meta property="og:image" content="${origin}/landing/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${quote(title)}" />
    <meta name="twitter:description" content="${quote(description)}" />
    <meta name="twitter:image" content="${origin}/landing/og.png" />
    <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2).replace(/</g, "\\u003c")}
    </script>
    ${style}
    <style>${postCss}</style>
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    ${header}
    <main id="main" class="post">
${main}
    </main>
    ${footer}
  </body>
</html>
`;
}

const blogUrl = `${origin}/blog/`;
const organization = {
  "@type": "Organization",
  "@id": `${origin}/#organization`,
  name: "Atelier Cloud",
  url: `${origin}/`,
  logo: `${origin}/landing/logo-1024.png`,
};

for (const post of posts) {
  const canonical = `/blog/${post.slug}`;
  const others = posts.filter((other) => other.slug !== post.slug);
  const main = `      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="/">Home</a> › <a href="/blog/">Tutorials</a>
      </nav>
      <article>
        <h1>${post.title}</h1>
${post.html.trimEnd()}
        ${
          post.sample
            ? `        <aside class="sample">
          <p>The files used are available as samples. Open them in a new workspace and follow along
          in the same editor.</p>
          <a class="sample-button" href="/workspaces/?sample=${post.sample}">Open a workspace with these files</a>
        </aside>
`
            : ""
        }        <p class="post-note">
          Last updated <time datetime="${post.updated}">${post.updated}</time>. Checked against
          PdfCraft ${post.pdfcraft}.
        </p>
      </article>
      <nav class="more" aria-label="More tutorials">
        <h2>More tutorials</h2>
        <ul>
${others.map((other) => `          <li><a href="/blog/${other.slug}">${other.title}</a></li>`).join("\n")}
        </ul>
      </nav>`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      organization,
      {
        "@type": "BlogPosting",
        headline: post.title,
        description: post.description,
        url: `${origin}${canonical}`,
        mainEntityOfPage: `${origin}${canonical}`,
        datePublished: post.updated,
        dateModified: post.updated,
        inLanguage: "en",
        image: `${origin}/landing/og.png`,
        keywords: post.keywords.join(", "),
        author: { "@id": `${origin}/#organization` },
        publisher: { "@id": `${origin}/#organization` },
        isPartOf: { "@id": `${origin}/blog/#collection` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Home",
            item: `${origin}/`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: "Tutorials",
            item: blogUrl,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: post.title,
            item: `${origin}${canonical}`,
          },
        ],
      },
    ],
  };
  await writeFile(
    join(outDir, `${post.slug}.html`),
    page({
      title: `${post.title} | Atelier Cloud`,
      description: post.description,
      canonical,
      jsonLd,
      main,
      keywords: post.keywords,
    }),
  );
}

const indexMain = `      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › Tutorials</nav>
      <article>
        <h1>PdfCraft tutorials</h1>
        <p>
          Short, tested walkthroughs for the PDF workbench that runs in the browser. Every step names
          the control you click, and the screenshots come from the app itself.
        </p>
        <ul class="index-list">
${posts
  .map(
    (post) => `          <li>
            <a href="/blog/${post.slug}">${post.title}</a>
            <p>${post.description}</p>
          </li>`,
  )
  .join("\n")}
        </ul>
      </article>`;

await writeFile(
  join(outDir, "index.html"),
  page({
    title: "PdfCraft tutorials | Atelier Cloud",
    description:
      "Short walkthroughs for PdfCraft in the browser: merge and split PDFs, fill in and sign a form, and redact a document before you share it.",
    canonical: "/blog/",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        organization,
        {
          "@type": "CollectionPage",
          "@id": `${origin}/blog/#collection`,
          name: "PdfCraft tutorials",
          url: blogUrl,
          inLanguage: "en",
        },
        {
          "@type": "ItemList",
          itemListElement: posts.map((post, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: post.title,
            url: `${origin}/blog/${post.slug}`,
          })),
        },
      ],
    },
    main: indexMain,
  }),
);

/**
 * A picture or a sample document is copied beside the pages, because the directory is rebuilt from
 * scratch on every run: `static/blog/` holds nothing this script did not put there.
 */
async function copyInto(from, to) {
  if (!existsSync(from)) return;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyInto(source, target);
    else await copyFile(source, target);
  }
}

await copyInto(join(contentDir, "images"), join(outDir, "images"));
await copyInto(join(contentDir, "samples"), join(outDir, "samples"));

/**
 * The date each page last changed, for the server's sitemap. A crawler uses `lastmod` to decide
 * whether to fetch a page again, so it comes from the frontmatter rather than from the clock: a
 * rebuild that changed no words must not tell Google that every page is new.
 */
const lastmod = {
  "/blog/": posts
    .map((post) => post.updated)
    .sort()
    .at(-1),
};
for (const post of posts) lastmod[`/blog/${post.slug}`] = post.updated;
await writeFile(
  join(outDir, "lastmod.json"),
  `${JSON.stringify(lastmod, null, 2)}\n`,
);

/**
 * The homepage carries one line per tutorial, so each article is linked from the page that gets the
 * links, not only from the list. Written between two markers in `landing/index.html`, which is why
 * that file is edited by the build: the alternative is a second list to keep in step by hand.
 */
const tutorialMarkers =
  /([ \t]*)<!-- tutorials:start -->[\s\S]*?<!-- tutorials:end -->/;
const items = posts
  .map(
    (post) => `  <li>
    <a href="/blog/${post.slug}">${post.title}</a>
    <p>${post.description}</p>
  </li>`,
  )
  .join("\n");
const replacement = `<!-- tutorials:start -->
<ul class="tutorials">
${items}
</ul>
<!-- tutorials:end -->`;
const landingHtml = await readFile(landingFile, "utf8");
if (!tutorialMarkers.test(landingHtml)) {
  throw new Error(
    "landing/index.html has no <!-- tutorials:start --> markers for the tutorial list",
  );
}
const updatedLanding = landingHtml.replace(tutorialMarkers, (_, indent) =>
  replacement
    .split("\n")
    .map((line) => indent + line)
    .join("\n"),
);
if (updatedLanding !== landingHtml)
  await writeFile(landingFile, updatedLanding);

/**
 * `llms.txt` is what a non-Google answer engine reads to learn what the site is and which page
 * answers which question (llmstxt.org). It is written from the same list as the index, so a new
 * tutorial appears in it without anyone remembering to add it there.
 */
const llms = `# Atelier Cloud

> Atelier Cloud runs PhotoCraft and PdfCraft in the browser tab. Documents are opened from the
> visitor's own machine and edited there: no upload, no account. PdfCraft is the PDF workbench, and
> the tutorials below are short, tested walkthroughs for it.

## What PdfCraft does in the browser

- Combine files into one PDF, split a document, and reorder or delete pages.
- Fill interactive PDF forms and place a typed, drawn or scanned signature.
- Redact text and images, then rewrite the file so the removed content is gone.
- Encrypt a PDF with a password, and restrict printing, copying and changes.
- Stamp page numbers into the footer, and flatten a filled form into page content.
- Recognise text in scans, reduce file size, and export to Word, PowerPoint, HTML or text.

## Tutorials

${posts.map((post) => `- [${post.title}](${origin}/blog/${post.slug}): ${post.description}`).join("\n")}

## Pages

- [Home](${origin}/): what the two editors do, and where files are kept.
- [Tutorials](${origin}/blog/): the full list.
- [Help](${origin}/workspaces/help): workspaces, versions and the editors.
`;
await writeFile(join(root, "static/llms.txt"), llms);

console.log(`blog: ${posts.length} posts and an index written to static/blog/`);
