#!/usr/bin/env node
// Captures a screenshot of the app at a size this script chooses, so a tutorial picture is the same
// size every time instead of whatever the editor's preview pane happens to be.
//
//   node scripts/shot.mjs --url "http://127.0.0.1:3000/pdfcraft/?file=/docs/report.pdf" \
//     --out shot.png --press Meta+k --type "combine files" --press Enter --wait 1500
//
// It drives the installed Chrome, so nothing downloads: an editor that lays itself out from the
// browser window gets a real 1440x900 window instead of a 665x441 pane.
//
// Steps run in the order they are given:
//   --press "Meta+k"   a key, or a key chord, sent to the page
//   --type "text"      typed into whatever has focus, which for this app is its command palette
//   --drop "a,b"       files dragged onto the page, which is how the editor takes documents
//   --wait 1500        a pause in milliseconds, for a dialog or a wasm frame to arrive
//   --mouse 840,520    put the pointer somewhere, which is what a zoom keeps under the cursor
//   --wheel 200,0      scroll, so a zoomed page can be panned into the middle
//   --click 611,293    click a point, for a tool in the palette
//   --tap 2400,240     the same, dispatched as pointer events inside the page, which the canvas accepts
//   --tap 2400,240,250 the same, holding the button down for 250 ms, which a check box needs
//   --drag 1200,600,1350,600  press, move and release, for panning a page
//   --tapdrag 400,300,700,500 the same, dispatched inside the page, which draws a selection
//
// Options:
//   --viewport 1440x900   window size in CSS pixels
//   --dsf 2               device scale factor, so the picture stays sharp when scaled down
//   --theme light|dark    what the app sees as the operating system's preference
//   --settle 8000         how long to wait for the first paint before the steps begin

import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const USAGE = `usage: shot --url <url> --out <file.png> [steps...]

  --press "Meta+k"    a key or chord
  --type "text"       text into the focused field
  --drop "a.pdf,b.pdf"  files dropped on the page
  --wait 1500         pause, in milliseconds
  --mouse 840,520     move the pointer, so a zoom keeps that spot on screen
  --wheel 200,0       scroll by pixels: x pans, y scrolls
  --click 611,293     click a point
  --tap x,y[,ms]      click the canvas through pointer events, holding the button for ms (60)
  --drag x1,y1,x2,y2  press, move and release
  --tapdrag x1,y1,x2,y2  drag through pointer events inside the canvas
  --viewport 1440x900  window size in CSS pixels (default 1440x900)
  --dsf 2             device scale factor (default 2)
  --theme light|dark  colour scheme the app starts in (default light)
  --settle 8000       wait for the first paint (default 8000 ms)
  --channel chrome    browser channel (default chrome)
  --full              capture the whole page, not the window`;

function fail(message) {
  console.error(`shot: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
const steps = [];
let url = null;
let out = null;
let viewport = [1440, 900];
let dsf = 2;
let theme = "light";
let settle = 8000;
let channel = "chrome";
let full = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const value = () => {
    if (i + 1 >= args.length) fail(`${arg} needs a value`);
    return args[++i];
  };
  switch (arg) {
    case "--url":
      url = value();
      break;
    case "--out":
      out = value();
      break;
    case "--press":
      steps.push({ kind: "press", value: value() });
      break;
    case "--type":
      steps.push({ kind: "type", value: value() });
      break;
    case "--drop":
      steps.push({
        kind: "drop",
        value: value()
          .split(",")
          .map((item) => item.trim()),
      });
      break;
    case "--wait":
      steps.push({ kind: "wait", value: Number(value()) });
      break;
    case "--mouse":
      steps.push({ kind: "mouse", value: value().split(",").map(Number) });
      break;
    case "--wheel":
      steps.push({ kind: "wheel", value: value().split(",").map(Number) });
      break;
    case "--click":
      steps.push({ kind: "click", value: value().split(",").map(Number) });
      break;
    case "--drag":
      steps.push({ kind: "drag", value: value().split(",").map(Number) });
      break;
    case "--tapdrag":
      steps.push({ kind: "tapdrag", value: value().split(",").map(Number) });
      break;
    case "--tap":
      steps.push({ kind: "tap", value: value().split(",").map(Number) });
      break;
    case "--viewport":
      viewport = value().split("x").map(Number);
      break;
    case "--dsf":
      dsf = Number(value());
      break;
    case "--theme":
      theme = value();
      break;
    case "--settle":
      settle = Number(value());
      break;
    case "--full":
      full = true;
      break;
    case "--channel":
      channel = value();
      break;
    case "-h":
    case "--help":
      console.log(USAGE);
      process.exit(0);
    default:
      fail(`unknown option ${arg}`);
  }
}

if (!url) fail("--url is required");
if (!out) fail("--out is required");
if (viewport.length !== 2 || viewport.some((n) => !Number.isFinite(n)))
  fail("--viewport wants WxH");
if (!["light", "dark"].includes(theme)) fail("--theme is light or dark");

const browser = await chromium.launch({ channel, headless: true });
const context = await browser.newContext({
  viewport: { width: viewport[0], height: viewport[1] },
  deviceScaleFactor: dsf,
  colorScheme: theme,
});
const page = await context.newPage();

await page.goto(url, { waitUntil: "load", timeout: 60000 });
// The editor needs its wasm and a first frame; a page with no canvas needs neither.
await page.waitForTimeout(settle);

for (const step of steps) {
  if (step.kind === "press") await page.keyboard.press(step.value);
  else if (step.kind === "type")
    await page.keyboard.type(step.value, { delay: 45 });
  else if (step.kind === "wait") await page.waitForTimeout(step.value);
  else if (step.kind === "mouse")
    await page.mouse.move(step.value[0], step.value[1]);
  else if (step.kind === "wheel")
    await page.mouse.wheel(step.value[0], step.value[1]);
  else if (step.kind === "click")
    await page.mouse.click(step.value[0], step.value[1]);
  else if (step.kind === "drag") {
    const [x1, y1, x2, y2] = step.value;
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 12 });
    await page.mouse.up();
  } else if (step.kind === "tapdrag") {
    // A drag has to arrive as pointer events inside the page too, or the canvas never sees it.
    const [x1, y1, x2, y2] = step.value;
    await page.evaluate(
      async ([x1, y1, x2, y2]) => {
        const canvas = document.querySelector("canvas");
        const box = canvas.getBoundingClientRect();
        const send = (type, x, y, buttons) => {
          const event = new PointerEvent(type, {
            clientX: x + box.left,
            clientY: y + box.top,
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons,
          });
          Object.defineProperty(event, "offsetX", { value: x });
          Object.defineProperty(event, "offsetY", { value: y });
          canvas.dispatchEvent(event);
        };
        const frame = () => new Promise((resolve) => setTimeout(resolve, 60));
        send("pointermove", x1, y1, 0);
        await frame();
        send("pointerdown", x1, y1, 1);
        await frame();
        for (let i = 1; i <= 8; i++) {
          send(
            "pointermove",
            x1 + ((x2 - x1) * i) / 8,
            y1 + ((y2 - y1) * i) / 8,
            1,
          );
          await frame();
        }
        send("pointerup", x2, y2, 0);
        await frame();
      },
      [x1, y1, x2, y2],
    );
  } else if (step.kind === "tap") {
    // The canvas wants pointer events rather than the driver's mouse, so this dispatches them inside
    // the page: a move, a press and a release at the same point.
    const [x, y, hold = 60] = step.value;
    await page.evaluate(
      async ([x, y, hold]) => {
        const canvas = document.querySelector("canvas");
        const box = canvas.getBoundingClientRect();
        const at = {
          clientX: x + box.left,
          clientY: y + box.top,
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
        };
        // egui reads the position relative to the canvas, and a dispatched event computes `offsetX`
        // from the target, so it is pinned to the coordinate asked for.
        const send = (type, buttons) => {
          const event = new PointerEvent(type, { ...at, buttons });
          Object.defineProperty(event, "offsetX", { value: x });
          Object.defineProperty(event, "offsetY", { value: y });
          canvas.dispatchEvent(event);
        };
        // A press and a release in the same frame is not a click to egui; a frame between them is.
        const frame = (ms = 60) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        send("pointermove", 0);
        await frame();
        send("pointerdown", 1);
        await frame(hold);
        send("pointerup", 0);
        await frame();
      },
      [x, y, hold],
    );
  } else if (step.kind === "drop") {
    const files = [];
    for (const path of step.value) {
      files.push({
        name: path.split("/").pop(),
        type: path.endsWith(".pdf")
          ? "application/pdf"
          : "application/octet-stream",
        data: (await readFile(path)).toString("base64"),
      });
    }
    await page.evaluate((incoming) => {
      const transfer = new DataTransfer();
      for (const file of incoming) {
        const bytes = Uint8Array.from(atob(file.data), (char) =>
          char.charCodeAt(0),
        );
        transfer.items.add(new File([bytes], file.name, { type: file.type }));
      }
      const canvas = document.querySelector("canvas");
      for (const type of ["dragenter", "dragover", "drop"]) {
        canvas.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
      }
    }, files);
  }
}

const png = await page.screenshot({ type: "png", fullPage: full });
await writeFile(out, png);
await browser.close();
console.log(
  `${out}: ${viewport[0]}x${viewport[1]} at ${dsf}x, ${steps.length} step(s)`,
);
