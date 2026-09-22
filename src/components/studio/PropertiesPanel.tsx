import { Trash2, DoorOpen, Info, MoveRight, ArrowLeftRight, Target } from "lucide-react";
import type { Hotspot, HotspotType, Scene } from "@/types/tour";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
interface Props {
  scene: Scene | null;
  scenes: Scene[];
  hotspot: Hotspot | null;
  onSceneChange: (patch: Partial<Scene>) => void;
  onHotspotChange: (patch: Partial<Hotspot>) => void;
  onDeleteSelectedHotspot?: () => void;
  onSelectHotspot?: (id: string | null) => void;
  onDeleteHotspot?: (id: string) => void;
  /** Chiamata quando l'utente attiva "Crea hotspot di ritorno" con la scena di destinazione */
  onCreateReverseHotspot?: (targetSceneId: string) => void;
}

export function PropertiesPanel({
  scene,
  scenes,
  hotspot,
  onSceneChange,
  onHotspotChange,
  onDeleteSelectedHotspot,
  onSelectHotspot,
  onDeleteHotspot,
  onCreateReverseHotspot,
}: Props) {
  const isInfo = hotspot?.type === "info";

  return (
    <aside className="flex w-76 shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar">
      <div className="border-b border-border px-3 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Scene properties
        </h2>
      </div>

      {scene ? (
        <div className="space-y-4 border-b border-border p-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Title</Label>
            <Input
              className="h-8 text-xs"
              value={scene.name}
              onChange={(e) => onSceneChange({ name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Default view</Label>
            <div className="flex items-start gap-2 rounded-md border border-border bg-panel px-2.5 py-2 text-[11px] text-muted-foreground">
              <Target className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="space-y-1">
                <div className="tabular-nums text-foreground">
                  Yaw {scene.defaultYaw.toFixed(1)}°, Pitch {scene.defaultPitch.toFixed(1)}°, Zoom{" "}
                  {scene.defaultZoom.toFixed(1)}x
                </div>
                <div>
                  Navigate the scene, then use "Set current view as default" in the viewer to update
                  it.
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-md border border-border bg-panel px-2.5 py-2 text-[11px] text-muted-foreground">
            {scene.hotspots.length} hotspot{scene.hotspots.length === 1 ? "" : "s"} in this scene
          </div>

          {scene.hotspots.length > 0 && (
            <div className="space-y-2 pt-2">
              <Label className="text-xs">Hotspots in scene</Label>
              <div className="space-y-2">
                {scene.hotspots.map((h) => {
                  const Icon = h.type === "door" ? DoorOpen : h.type === "info" ? Info : MoveRight;
                  return (
                    <div
                      key={h.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-panel p-2 cursor-pointer"
                      onClick={() => onSelectHotspot?.(h.id)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium">{h.tooltip || h.type}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {h.pitch.toFixed(1)}°, {h.yaw.toFixed(1)}°
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectHotspot?.(h.id);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 w-7 p-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteHotspot?.(h.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="border-b border-border p-3 text-xs text-muted-foreground">
          No scene selected.
        </p>
      )}

      <div className="border-b border-border px-3 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Hotspot properties
        </h2>
      </div>

      {hotspot ? (
        <div className="space-y-4 p-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Type</Label>
            <Select
              value={hotspot.type}
              onValueChange={(v) => onHotspotChange({ type: v as HotspotType })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="door">Door (navigate)</SelectItem>
                <SelectItem value="arrow">Arrow (navigate)</SelectItem>
                <SelectItem value="info">Info</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Tooltip</Label>
            <Input
              className="h-8 text-xs"
              value={hotspot.tooltip}
              onChange={(e) => onHotspotChange({ tooltip: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Pitch</Label>
              <Input
                type="number"
                className="h-8 text-xs"
                value={hotspot.pitch}
                onChange={(e) => onHotspotChange({ pitch: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Yaw</Label>
              <Input
                type="number"
                className="h-8 text-xs"
                value={hotspot.yaw}
                onChange={(e) => onHotspotChange({ yaw: Number(e.target.value) })}
              />
            </div>
          </div>

          {/* Target scene: hidden for info markers, shown for navigation markers */}
          {!isInfo && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Target scene</Label>
                <Select
                  value={hotspot.targetSceneId ?? "none"}
                  onValueChange={(v) => onHotspotChange({ targetSceneId: v === "none" ? null : v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {scenes
                      .filter((s) => s.id !== scene?.id)
                      .map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              {hotspot.targetSceneId && (
                <div className="flex items-center justify-between rounded-md border border-border bg-panel px-3 py-2">
                  <div className="flex items-center gap-2">
                    <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <Label className="text-xs cursor-pointer" htmlFor="reverse-hotspot">
                      Create return hotspot
                    </Label>
                  </div>
                  <Switch
                    id="reverse-hotspot"
                    onCheckedChange={(checked) => {
                      if (checked && hotspot.targetSceneId) {
                        onCreateReverseHotspot?.(hotspot.targetSceneId);
                      }
                    }}
                  />
                </div>
              )}
            </>
          )}

          {/* Markdown content editor for info markers */}
          {isInfo && (
            <div className="space-y-1.5">
              <Label className="text-xs">Content (Markdown)</Label>
              <textarea
                className="w-full h-32 resize-y rounded-md border border-border bg-slate-800 p-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={hotspot.content ?? ""}
                onChange={(e) => onHotspotChange({ content: e.target.value })}
                placeholder="Write Markdown content here..."
              />
            </div>
          )}

          <Button
            variant="destructive"
            size="sm"
            className="w-full"
            onClick={() => {
              if (onDeleteSelectedHotspot) return onDeleteSelectedHotspot();
              if (hotspot) {
                onDeleteHotspot?.(hotspot.id);
              }
            }}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete hotspot
          </Button>
        </div>
      ) : (
        <p className="p-3 text-xs text-muted-foreground">
          Select a hotspot on the canvas, or use "Add Hotspot" to place a new one.
        </p>
      )}
    </aside>
  );
}
