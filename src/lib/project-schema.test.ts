import assert from "node:assert/strict";
import { test } from "node:test";
import { CURRENT_SCHEMA_VERSION } from "@/types/tour";
import { ProjectValidationError } from "./storage-errors";
import { validateOrMigrateProject } from "./project-schema";

function baseProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: "p1",
    name: "Test tour",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    initialSceneId: null,
    scenes: [],
    floorplans: [],
    ...overrides,
  };
}

function rejects(data: unknown): string[] {
  try {
    validateOrMigrateProject(data);
  } catch (e) {
    assert.ok(e instanceof ProjectValidationError, "should throw ProjectValidationError");
    return e.issues;
  }
  throw new Error("expected validateOrMigrateProject to throw");
}

// ─── Theme defaults & backward compatibility ───────────────────────────────

test("fills in theme defaults, including an empty overlays array, when theme is omitted", () => {
  const project = validateOrMigrateProject(baseProject());
  assert.deepEqual(project.theme, {
    showNavbar: true,
    showTitleOverlay: true,
    logoUrl: "",
    overlays: [],
  });
});

test("accepts a theme saved by an earlier version (no 'overlays' field)", () => {
  const project = validateOrMigrateProject(
    baseProject({ theme: { showNavbar: false, showTitleOverlay: true, logoUrl: "" } }),
  );
  assert.equal(project.theme.showNavbar, false);
  assert.deepEqual(project.theme.overlays, []);
});

test("accepts a local 'asset:' logo reference", () => {
  const project = validateOrMigrateProject(
    baseProject({ theme: { logoUrl: "asset:logo_ab12cd.png" } }),
  );
  assert.equal(project.theme.logoUrl, "asset:logo_ab12cd.png");
});

test("rejects a logoUrl with an unsafe 'asset:' reference (path traversal)", () => {
  const issues = rejects(baseProject({ theme: { logoUrl: "asset:../../etc/passwd" } }));
  assert.ok(issues.some((i) => i.includes("theme.logoUrl") && i.includes("invalid 'asset:'")));
});

// ─── Overlay elements ───────────────────────────────────────────────────────

test("accepts an overlay element and fills in its defaults", () => {
  const project = validateOrMigrateProject(
    baseProject({
      theme: {
        overlays: [{ id: "o1", type: "logo", position: "top-left", content: "asset:logo.png" }],
      },
    }),
  );
  assert.deepEqual(project.theme.overlays, [
    {
      id: "o1",
      type: "logo",
      position: "top-left",
      offsetX: 0,
      offsetY: 0,
      offsetUnit: "px",
      style: {},
      content: "asset:logo.png",
    },
  ]);
});

test("accepts a text overlay with {{variable}} content and a custom style", () => {
  const project = validateOrMigrateProject(
    baseProject({
      theme: {
        overlays: [
          {
            id: "o1",
            type: "text",
            position: "bottom-center",
            offsetX: 10,
            offsetY: -5,
            offsetUnit: "%",
            style: { opacity: 0.8, fontSize: 14, color: "#ffffff" },
            content: "{{scene.title}}",
          },
        ],
      },
    }),
  );
  const overlay = project.theme.overlays[0]!;
  assert.equal(overlay.content, "{{scene.title}}");
  assert.equal(overlay.offsetUnit, "%");
  assert.deepEqual(overlay.style, { opacity: 0.8, fontSize: 14, color: "#ffffff" });
});

test("rejects an unsafe 'asset:' reference in a logo/image overlay's content", () => {
  const issues = rejects(
    baseProject({
      theme: {
        overlays: [
          { id: "o1", type: "image", position: "top-right", content: "asset:../../evil.png" },
        ],
      },
    }),
  );
  assert.ok(issues.some((i) => i.includes("invalid 'asset:'")));
});

test("does not asset-validate a text overlay's content, even if it looks like a path", () => {
  const project = validateOrMigrateProject(
    baseProject({
      theme: {
        overlays: [
          { id: "o1", type: "text", position: "top-right", content: "asset:../not-a-real-ref" },
        ],
      },
    }),
  );
  assert.equal(project.theme.overlays[0]!.content, "asset:../not-a-real-ref");
});

test("rejects duplicate overlay ids", () => {
  const issues = rejects(
    baseProject({
      theme: {
        overlays: [
          { id: "dup", type: "text", position: "top-left", content: "a" },
          { id: "dup", type: "text", position: "bottom-left", content: "b" },
        ],
      },
    }),
  );
  assert.ok(issues.some((i) => i.includes('duplicate overlay id "dup"')));
});

test("rejects an invalid overlay type, position or offset unit", () => {
  const badType = rejects(
    baseProject({
      theme: { overlays: [{ id: "o1", type: "video", position: "top-left", content: "" }] },
    }),
  );
  assert.ok(badType.some((i) => i.startsWith("theme.overlays[0].type")));

  const badPosition = rejects(
    baseProject({
      theme: { overlays: [{ id: "o1", type: "text", position: "center", content: "" }] },
    }),
  );
  assert.ok(badPosition.some((i) => i.startsWith("theme.overlays[0].position")));

  const badUnit = rejects(
    baseProject({
      theme: {
        overlays: [
          {
            id: "o1",
            type: "text",
            position: "top-left",
            offsetUnit: "em",
            content: "",
          },
        ],
      },
    }),
  );
  assert.ok(badUnit.some((i) => i.startsWith("theme.overlays[0].offsetUnit")));
});
