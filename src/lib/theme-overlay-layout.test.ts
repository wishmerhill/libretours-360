import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThemeOverlayElement } from "@/types/tour";
import {
  THEME_CANVAS_BREAKPOINTS,
  computeFitScale,
  overlayAnchorStyle,
  overlayElementStyle,
  resolveOverlayVariables,
  themeCanvasBreakpoint,
} from "./theme-overlay-layout";

function overlay(over: Partial<ThemeOverlayElement> = {}): ThemeOverlayElement {
  return {
    id: "o1",
    type: "text",
    position: "top-left",
    offsetX: 0,
    offsetY: 0,
    offsetUnit: "px",
    style: {},
    content: "",
    ...over,
  };
}

// ─── Breakpoints ────────────────────────────────────────────────────────────

test("declares exactly desktop, tablet and mobile, each with a positive frame size", () => {
  assert.deepEqual(
    THEME_CANVAS_BREAKPOINTS.map((b) => b.id),
    ["desktop", "tablet", "mobile"],
  );
  for (const b of THEME_CANVAS_BREAKPOINTS) {
    assert.ok(b.width > 0 && b.height > 0, `${b.id} should have a positive size`);
  }
});

test("themeCanvasBreakpoint looks up by id and falls back to desktop for an unknown one", () => {
  assert.equal(themeCanvasBreakpoint("tablet").width, 768);
  assert.equal(themeCanvasBreakpoint("mobile").height, 667);
  // @ts-expect-error deliberately invalid id, to check the runtime fallback
  assert.equal(themeCanvasBreakpoint("watch").id, "desktop");
});

// ─── computeFitScale ────────────────────────────────────────────────────────

test("computeFitScale shrinks to fit the smaller dimension, and never upscales", () => {
  // Mobile frame (375x667) in a much larger container: capped at 1 (no upscale).
  assert.equal(computeFitScale({ width: 375, height: 667 }, { width: 2000, height: 2000 }), 1);

  // Desktop frame (1920x1080) in a small container: height is the limiting dimension.
  const scale = computeFitScale({ width: 1920, height: 1080 }, { width: 1200, height: 700 }, 20);
  const expected = Math.min((1200 - 40) / 1920, (700 - 40) / 1080);
  assert.ok(Math.abs(scale - expected) < 1e-9);
});

test("computeFitScale falls back to 1 for an unmeasured (zero-size) container", () => {
  assert.equal(computeFitScale({ width: 1920, height: 1080 }, { width: 0, height: 0 }), 1);
});

test("computeFitScale falls back to 1 when padding leaves no room", () => {
  assert.equal(computeFitScale({ width: 1920, height: 1080 }, { width: 100, height: 100 }, 200), 1);
});

// ─── overlayAnchorStyle ─────────────────────────────────────────────────────

test("overlayAnchorStyle: top-left uses top/left offsets", () => {
  const style = overlayAnchorStyle(overlay({ position: "top-left", offsetX: 10, offsetY: 20 }));
  assert.deepEqual(style, { position: "absolute", top: "20px", left: "10px" });
});

test("overlayAnchorStyle: bottom-right uses bottom/right offsets", () => {
  const style = overlayAnchorStyle(overlay({ position: "bottom-right", offsetX: 5, offsetY: 8 }));
  assert.deepEqual(style, { position: "absolute", bottom: "8px", right: "5px" });
});

test("overlayAnchorStyle: *-center anchors are horizontally centered with a calc() offset", () => {
  const style = overlayAnchorStyle(
    overlay({ position: "top-center", offsetX: 12, offsetY: 4, offsetUnit: "%" }),
  );
  assert.equal(style.position, "absolute");
  assert.equal(style.top, "4%");
  assert.equal(style.left, "calc(50% + 12%)");
  assert.equal(style.transform, "translateX(-50%)");
});

test("overlayAnchorStyle: percentage offsets are kept as CSS percentages, not resolved to px", () => {
  const style = overlayAnchorStyle(
    overlay({ position: "bottom-left", offsetX: 5, offsetY: 10, offsetUnit: "%" }),
  );
  assert.equal(style.left, "5%");
  assert.equal(style.bottom, "10%");
});

test("overlayAnchorStyle covers all six anchors with the right side/axis", () => {
  const cases: [ThemeOverlayElement["position"], "top" | "bottom", "left" | "right" | undefined][] =
    [
      ["top-left", "top", "left"],
      ["top-right", "top", "right"],
      ["bottom-left", "bottom", "left"],
      ["bottom-right", "bottom", "right"],
      ["top-center", "top", undefined],
      ["bottom-center", "bottom", undefined],
    ];
  for (const [position, vSide, hSide] of cases) {
    const style = overlayAnchorStyle(overlay({ position }));
    assert.ok(vSide in style, `${position} should set "${vSide}"`);
    if (hSide) assert.ok(hSide in style, `${position} should set "${hSide}"`);
    else assert.ok(style.transform, `${position} should center via transform`);
  }
});

// ─── overlayElementStyle ────────────────────────────────────────────────────

test("overlayElementStyle maps only the fields that are set", () => {
  assert.deepEqual(overlayElementStyle({}), {});
  assert.deepEqual(overlayElementStyle({ opacity: 0.5, color: "#fff" }), {
    opacity: 0.5,
    color: "#fff",
  });
});

test("overlayElementStyle maps every style field to its CSS counterpart", () => {
  const style = overlayElementStyle({
    opacity: 0.9,
    width: 120,
    height: 40,
    padding: 8,
    backgroundColor: "#000000cc",
    fontSize: 14,
    fontFamily: "Inter, sans-serif",
    color: "#ffffff",
  });
  assert.deepEqual(style, {
    opacity: 0.9,
    width: 120,
    height: 40,
    padding: 8,
    backgroundColor: "#000000cc",
    fontSize: 14,
    fontFamily: "Inter, sans-serif",
    color: "#ffffff",
  });
});

// ─── resolveOverlayVariables ────────────────────────────────────────────────

test("resolveOverlayVariables substitutes known variables", () => {
  assert.equal(
    resolveOverlayVariables("{{scene.title}} — {{project.name}}", {
      "scene.title": "Living room",
      "project.name": "My Tour",
    }),
    "Living room — My Tour",
  );
});

test("resolveOverlayVariables leaves an unknown variable as literal text", () => {
  assert.equal(
    resolveOverlayVariables("Hello {{scene.subtitle}}", { "scene.title": "Living room" }),
    "Hello {{scene.subtitle}}",
  );
});

test("resolveOverlayVariables leaves plain text untouched", () => {
  assert.equal(resolveOverlayVariables("Just text, no variables", {}), "Just text, no variables");
});
