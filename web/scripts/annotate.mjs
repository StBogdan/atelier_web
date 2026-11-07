#!/usr/bin/env node
// Marks up a screenshot: a numbered badge outside the control, an arrow to it, and a ring around it.
// It is the tool behind the pictures in `content/blog/images/`, and it exists because a tutorial gets
// its pictures from the app and its numbers from that markup, over and over.
//
//   node scripts/annotate.mjs shot.png out.png --mark "1@520,366:600,383,818,437"
//   npm run annotate -- shot.png out.png --mark "1@520,366:600,383,818,437"
//
// A mark is `[label@]badgeX,badgeY:left,top,right,bottom`. The label defaults to the mark's position
// in the list, so three marks without labels are numbered 1, 2 and 3. Coordinates are pixels of the
// input image, which for a 2x capture is twice the CSS pixels of the app.
//
// The arrow is worked out rather than supplied: it leaves the badge on the side that faces the box
// and stops at the box's edge. A badge inside the box draws the ring alone, which is how a mark calls
// out a whole panel.
//
// Options:
//   --crop x,y,w,h   crop to that box first, so the output can be one element of a page
//   --scale 0.5      resize the output, for the 2x capture that a page only needs at 1x
//   --color #2f6feb  accent for badges, rings and arrows (repeatable per mark with `--mark-color`)
//   --badge 24       badge radius             --stroke 6   ring and arrow width
//   --no-arrow       rings only
//   --grid 200       draw a labelled grid under the marks, to read and correct coordinates

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import sharp from "sharp";

const USAGE = `usage: annotate <in.png> <out.png> --mark "[label@]x,y:x1,y1,x2,y2" [...]

  --crop x,y,w,h    crop before annotating (input pixels)
  --scale n         resize the output (0.5 halves a 2x capture)
  --color #rrggbb   accent colour (default #2f6feb)
  --badge n         badge radius, default 24
  --stroke n        ring and arrow width, default 6
  --no-arrow        draw the rings without arrows
  --grid 200        draw a labelled grid under the marks, to read coordinates`;

function fail(message) {
  console.error(`annotate: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function numbers(text, count, what) {
  const parts = text.split(",").map((part) => Number(part.trim()));
  if (
    parts.length !== count ||
    parts.some((value) => !Number.isFinite(value))
  ) {
    fail(`${what} wants ${count} numbers, got "${text}"`);
  }
  return parts;
}

function parseMark(text, index) {
  const at = text.indexOf("@");
  const colon = text.indexOf(":", at === -1 ? 0 : at);
  if (colon === -1) fail(`a mark is [label@]x,y:x1,y1,x2,y2, got "${text}"`);
  const label = at === -1 ? String(index) : text.slice(0, at);
  const badge = numbers(
    at === -1 ? text.slice(0, colon) : text.slice(at + 1, colon),
    2,
    "a badge position",
  );
  const [x1, y1, x2, y2] = numbers(text.slice(colon + 1), 4, "a box");
  return {
    label,
    badge,
    box: [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ],
  };
}

const args = process.argv.slice(2);
const positional = [];
const marks = [];
let crop = null;
let scale = 1;
let color = "#2f6feb";
let badge = 24;
let stroke = 6;
let arrows = true;
let grid = 0;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const value = () => {
    if (i + 1 >= args.length) fail(`${arg} needs a value`);
    return args[++i];
  };
  switch (arg) {
    case "--mark":
      marks.push(parseMark(value(), marks.length + 1));
      break;
    case "--crop": {
      const [x, y, w, h] = numbers(value(), 4, "--crop");
      crop = {
        left: Math.round(x),
        top: Math.round(y),
        width: Math.round(w),
        height: Math.round(h),
      };
      break;
    }
    case "--scale":
      scale = Number(value());
      if (!Number.isFinite(scale) || scale <= 0)
        fail("--scale wants a positive number");
      break;
    case "--color":
      color = value();
      break;
    case "--badge":
      badge = Number(value());
      break;
    case "--stroke":
      stroke = Number(value());
      break;
    case "--no-arrow":
      arrows = false;
      break;
    case "--grid":
      grid = Number(value()) || 100;
      break;
    case "-h":
    case "--grid":
      grid = Number(value() || 100);
      break;
    case "--help":
      console.log(USAGE);
      process.exit(0);
    default:
      if (arg.startsWith("-")) fail(`unknown option ${arg}`);
      positional.push(arg);
  }
}

if (positional.length !== 2) fail("name the input and the output image");
const [input, output] = positional;
// No marks at all is a plain crop, resize or format change, which is how an unmarked "after" picture
// is made from the same capture.

/** Where an arrow from the badge meets the box, and where it starts on the badge's edge. */
function arrowFor([bx, by], [x1, y1, x2, y2]) {
  const inside = bx >= x1 && bx <= x2 && by >= y1 && by <= y2;
  if (inside || !arrows) return null;
  const target = [
    Math.min(Math.max(bx, x1), x2),
    Math.min(Math.max(by, y1), y2),
  ];
  const dx = target[0] - bx;
  const dy = target[1] - by;
  const length = Math.hypot(dx, dy) || 1;
  const unit = [dx / length, dy / length];
  const start = [bx + unit[0] * (badge + 8), by + unit[1] * (badge + 8)];
  const end = [target[0] - unit[0] * 8, target[1] - unit[1] * 8];
  const head = 22;
  const spread = (26 * Math.PI) / 180;
  const angle = Math.atan2(unit[1], unit[0]);
  const barb = (sign) => [
    end[0] - head * Math.cos(angle + sign * spread),
    end[1] - head * Math.sin(angle + sign * spread),
  ];
  return { start, end, barbs: [barb(1), barb(-1)] };
}

const source = sharp(await readFile(input)).ensureAlpha();
const meta = await source.metadata();
const frame = crop ?? {
  left: 0,
  top: 0,
  width: meta.width,
  height: meta.height,
};
const base = await source.extract(frame).toBuffer();
const width = frame.width;
const height = frame.height;

const shifted = marks.map((mark) => ({
  label: mark.label,
  badge: [mark.badge[0] - frame.left, mark.badge[1] - frame.top],
  box: mark.box.map(
    (value, index) => value - (index % 2 === 0 ? frame.left : frame.top),
  ),
}));

const parts = [];
if (grid) {
  for (let x = 0; x <= width; x += grid) {
    parts.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#ff2d95" stroke-width="1" stroke-opacity="0.45"/>`,
    );
    parts.push(
      `<text x="${x + 3}" y="14" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#ff2d95">${x + frame.left}</text>`,
    );
  }
  for (let y = 0; y <= height; y += grid) {
    parts.push(
      `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#ff2d95" stroke-width="1" stroke-opacity="0.45"/>`,
    );
    parts.push(
      `<text x="3" y="${y - 4 < 10 ? y + 12 : y - 4}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#ff2d95">${y + frame.top}</text>`,
    );
  }
}
for (const mark of shifted) {
  const [x1, y1, x2, y2] = mark.box;
  parts.push(
    `<rect x="${x1 - 4}" y="${y1 - 4}" width="${x2 - x1 + 8}" height="${y2 - y1 + 8}" rx="12" ry="12" fill="none" stroke="${color}" stroke-width="${stroke}"/>`,
  );
  const arrow = arrowFor(mark.badge, mark.box);
  if (arrow) {
    parts.push(
      `<path d="M${arrow.start[0]} ${arrow.start[1]} L${arrow.end[0]} ${arrow.end[1]} M${arrow.barbs[0][0]} ${arrow.barbs[0][1]} L${arrow.end[0]} ${arrow.end[1]} L${arrow.barbs[1][0]} ${arrow.barbs[1][1]}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }
  parts.push(
    `<circle cx="${mark.badge[0]}" cy="${mark.badge[1]}" r="${badge}" fill="${color}"/>`,
    `<text x="${mark.badge[0]}" y="${mark.badge[1]}" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-weight="bold" font-size="${Math.round(badge * 1.15)}" fill="#fff">${mark.label}</text>`,
  );
}

// The overlay declares the output size and keeps the source coordinates as its viewBox, so `--scale`
// shrinks the picture and the marks together, and the shapes stay vectors until the last moment.
const outWidth = Math.round(width * scale);
const outHeight = Math.round(height * scale);
const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;

// Resize first: sharp composites after it, and a composite larger than the base is refused.
const result = sharp(base)
  .resize({ width: outWidth })
  .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }]);
// A `.webp` name asks for WebP, which is a third of the bytes of the same PNG at this size and is what
// a page should be serving; every other name stays PNG.
const encoded = output.endsWith(".webp")
  ? await result.webp({ quality: 82 }).toBuffer()
  : await result.png().toBuffer();
await writeFile(output, encoded);
console.log(
  `${basename(output)}: ${marks.length} mark(s), ${outWidth}x${outHeight}`,
);
