import { test } from "node:test";
import assert from "node:assert/strict";
import { bar, colorEnabled, createUi, stripAnsi, visibleWidth, wrap } from "../src/cli/ui.ts";

test("color only on an interactive terminal, with NO_COLOR, CI and FORCE_COLOR respected", () => {
  assert.equal(colorEnabled({}, true), true);
  assert.equal(colorEnabled({}, false), false);
  assert.equal(colorEnabled({ NO_COLOR: "1" }, true), false);
  assert.equal(colorEnabled({ CI: "true" }, true), false);
  assert.equal(colorEnabled({ TERM: "dumb" }, true), false);
  assert.equal(colorEnabled({ FORCE_COLOR: "1", NO_COLOR: "1" }, false), true);
  assert.equal(colorEnabled({ FORCE_COLOR: "0" }, false), false);
});

test("widths ignore escape codes; wrap breaks on spaces", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(visibleWidth("\x1b[1m✓ ok\x1b[0m"), 4);
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrap("a\nb", 10), ["a", "b"]);
  assert.deepEqual(bar(1, 4, 8), { full: "██", empty: "██████".replace(/█/g, "░") });
  assert.deepEqual(bar(0, 0, 4), { full: "", empty: "░░░░" });
});

test("every row of a box has the same width, in color and in plain text", () => {
  for (const color of [true, false]) {
    const ui = createUi({ color, columns: 60 });
    const rows = ui.box([ui.meter("cases", 4, 5, "note"), ui.c.gold("read these: x"), ""], "1 failed").split("\n");
    assert.ok(
      rows.every((r) => visibleWidth(r) === ui.width),
      rows.map(visibleWidth).join(","),
    );
  }
});

test("plain mode prints no escape codes and a one-line header", () => {
  const ui = createUi({ color: false });
  assert.equal(ui.banner("0.2.0", "x"), "noxeval 0.2.0");
  const line = ui.caseLine({ id: "a", passed: false, ms: 5, judge: { pass: true }, failures: ["missing: x", "leak: y"] });
  assert.equal(line, stripAnsi(line));
  assert.match(line, /✗ a .* 5 ms .*judge ✓\n {4}├ missing: x\n {4}└ leak: y/);
  // Tool calls (0.3) go between the case line and the reasons.
  const withTools = ui.caseLine({ id: "b", passed: false, ms: 5, failures: ["tool-forbidden: send_email"], tools: ["send_email(to=hr)"] });
  assert.match(withTools, /✗ b .*\n {4}tools: send_email\(to=hr\)\n {4}└ tool-forbidden: send_email/);
  assert.ok(createUi({ color: true }).banner("0.2.0", "x").includes("\x1b[38;2;139;108;255m█▄ █ █▀█ ▀▄▀"));
});
