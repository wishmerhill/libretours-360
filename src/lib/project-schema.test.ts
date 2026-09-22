import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION } from "@/types/tour";
import { validateOrMigrateProject } from "./project-schema";

const baseProject = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id: "tour_1",
  name: "My Tour",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  initialSceneId: null,
  theme: { showNavbar: true, showTitleOverlay: true, logoUrl: "" },
  floorplans: [],
  scenes: [
    {
      id: "scene_a",
      name: "Hall",
      panoramaUrl: "https://example.com/a.jpg",
      defaultZoom: 1,
      defaultYaw: 0,
      defaultPitch: 0,
      hotspots: [] as unknown[],
    },
  ],
};

test("hotspot rotationX/Y/Z default to 0 when absent (old tours without them)", () => {
  const data = structuredClone(baseProject);
  data.scenes[0]!.hotspots = [
    { id: "h1", type: "arrow", pitch: 5, yaw: 20, tooltip: "Go", targetSceneId: null },
  ];
  const project = validateOrMigrateProject(data);
  const hotspot = project.scenes[0]!.hotspots[0]!;
  assert.equal(hotspot.rotationX, 0);
  assert.equal(hotspot.rotationY, 0);
  assert.equal(hotspot.rotationZ, 0);
});

test("hotspot rotationX/Y/Z round-trip when present", () => {
  const data = structuredClone(baseProject);
  data.scenes[0]!.hotspots = [
    {
      id: "h1",
      type: "arrow",
      pitch: 5,
      yaw: 20,
      tooltip: "Go",
      targetSceneId: null,
      rotationX: -80,
      rotationY: 35,
      rotationZ: 7,
    },
  ];
  const project = validateOrMigrateProject(data);
  const hotspot = project.scenes[0]!.hotspots[0]!;
  assert.equal(hotspot.rotationX, -80);
  assert.equal(hotspot.rotationY, 35);
  assert.equal(hotspot.rotationZ, 7);
});

test("non-finite rotation values are rejected", () => {
  const data = structuredClone(baseProject);
  data.scenes[0]!.hotspots = [
    { id: "h1", type: "arrow", pitch: 5, yaw: 20, tooltip: "Go", rotationX: Number.NaN },
  ];
  assert.throws(() => validateOrMigrateProject(data));
});
