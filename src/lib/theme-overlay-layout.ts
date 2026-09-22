/**
 * Pure layout helpers for the Theme Canvas (responsive preview + overlay
 * placement). No DOM, no React runtime dependency (CSSProperties is a
 * type-only import), so this is testable in Node like the rest of lib/.
 */
import type { CSSProperties } from "react";
import type {
  ThemeOverlayElement,
  ThemeOverlayElementStyle,
  ThemeOverlayOffsetUnit,
} from "@/types/tour";

export type ThemeCanvasBreakpointId = "desktop" | "tablet" | "mobile";

export interface ThemeCanvasBreakpoint {
  id: ThemeCanvasBreakpointId;
  /** Reference frame size in px (Desktop: a common 16:9 desktop resolution). */
  width: number;
  height: number;
}

export const THEME_CANVAS_BREAKPOINTS: readonly ThemeCanvasBreakpoint[] = [
  { id: "desktop", width: 1920, height: 1080 },
  { id: "tablet", width: 768, height: 1024 },
  { id: "mobile", width: 375, height: 667 },
];

export function themeCanvasBreakpoint(id: ThemeCanvasBreakpointId): ThemeCanvasBreakpoint {
  return THEME_CANVAS_BREAKPOINTS.find((b) => b.id === id) ?? THEME_CANVAS_BREAKPOINTS[0]!;
}

/**
 * Scale (0..1] that fits `frame` inside `container` minus `padding` on every
 * side, without ever upscaling. Falls back to 1 when either size is not
 * usable yet (e.g. the container has not been measured).
 */
export function computeFitScale(
  frame: { width: number; height: number },
  container: { width: number; height: number },
  padding = 32,
): number {
  if (frame.width <= 0 || frame.height <= 0) return 1;
  const availW = container.width - padding * 2;
  const availH = container.height - padding * 2;
  if (availW <= 0 || availH <= 0) return 1;
  return Math.min(availW / frame.width, availH / frame.height, 1);
}

function offsetValue(value: number, unit: ThemeOverlayOffsetUnit): string {
  return unit === "%" ? `${value}%` : `${value}px`;
}

/**
 * Absolute-positioning CSS for an overlay element's anchor + offset.
 * Percentage offsets stay CSS percentages (not resolved to px here), so the
 * placement scales naturally with the frame at every breakpoint.
 */
export function overlayAnchorStyle(
  el: Pick<ThemeOverlayElement, "position" | "offsetX" | "offsetY" | "offsetUnit">,
): CSSProperties {
  const [vAnchor, hAnchor] = el.position.split("-") as [
    "top" | "bottom",
    "left" | "center" | "right",
  ];
  const offX = offsetValue(el.offsetX, el.offsetUnit);
  const offY = offsetValue(el.offsetY, el.offsetUnit);

  const style: CSSProperties = { position: "absolute" };
  if (vAnchor === "top") style.top = offY;
  else style.bottom = offY;

  if (hAnchor === "left") {
    style.left = offX;
  } else if (hAnchor === "right") {
    style.right = offX;
  } else {
    style.left = `calc(50% + ${offX})`;
    style.transform = "translateX(-50%)";
  }
  return style;
}

/** Maps a ThemeOverlayElementStyle to inline CSS; unset fields are left to the caller's defaults. */
export function overlayElementStyle(style: ThemeOverlayElementStyle): CSSProperties {
  const css: CSSProperties = {};
  if (style.opacity !== undefined) css.opacity = style.opacity;
  if (style.width !== undefined) css.width = style.width;
  if (style.height !== undefined) css.height = style.height;
  if (style.padding !== undefined) css.padding = style.padding;
  if (style.backgroundColor !== undefined) css.backgroundColor = style.backgroundColor;
  if (style.fontSize !== undefined) css.fontSize = style.fontSize;
  if (style.fontFamily !== undefined) css.fontFamily = style.fontFamily;
  if (style.color !== undefined) css.color = style.color;
  return css;
}

/**
 * Replaces "{{scene.title}}", "{{project.name}}", ... with the given values.
 * A variable not present in `variables` is left as literal text, so a typo
 * stays visible instead of silently disappearing.
 */
export function resolveOverlayVariables(
  content: string,
  variables: Record<string, string>,
): string {
  return content.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key]! : match,
  );
}
