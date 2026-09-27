import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("every Recharts plot disables its focusable accessibility layer", () => {
  const charts = [...app.matchAll(/<(?:BarChart|PieChart)\b([^>]*)>/g)];
  assert.equal(charts.length, 2);
  for (const [, props] of charts) assert.match(props, /accessibilityLayer=\{false\}/);
});

test("dashboard chart focus cannot draw the browser's SVG outline", () => {
  assert.match(css, /\.dashboard \.recharts-wrapper:focus,\s*\.dashboard \.recharts-wrapper :focus\s*\{\s*outline:\s*none;/);
});
