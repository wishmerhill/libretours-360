import { useTranslation } from "react-i18next";
import { Trash2, DoorOpen, Info, MoveRight, ArrowLeftRight, Target, Ruler } from "lucide-react";
import type { Hotspot, HotspotType, MeasurePoint, Measurement, Scene } from "@/types/tour";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
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
  measurement: Measurement | null;
  onMeasurementChange: (patch: Partial<Measurement>) => void;
  onSelectMeasurement: (id: string | null) => void;
  onDeleteMeasurement: (id: string) => void;
  /** project.showMeasurements: initial visibility in the exported tour */
  showMeasurementsInExport: boolean;
  onShowMeasurementsInExportChange: (value: boolean) => void;
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
  measurement,
  onMeasurementChange,
  onSelectMeasurement,
  onDeleteMeasurement,
  showMeasurementsInExport,
  onShowMeasurementsInExportChange,
}: Props) {
  const { t } = useTranslation();
  const isInfo = hotspot?.type === "info";

  return (
    <aside className="flex w-76 shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar">
      <div className="border-b border-border px-3 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("editor.properties.sceneTitle")}
        </h2>
      </div>

      {scene ? (
        <div className="space-y-4 border-b border-border p-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("editor.properties.title")}</Label>
            <Input
              className="h-8 text-xs"
              value={scene.name}
              onChange={(e) => onSceneChange({ name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("editor.properties.defaultView")}</Label>
            <div className="flex items-start gap-2 rounded-md border border-border bg-panel px-2.5 py-2 text-[11px] text-muted-foreground">
              <Target className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="space-y-1">
                <div className="tabular-nums text-foreground">
                  {t("editor.properties.defaultViewSummary", {
                    yaw: scene.defaultYaw.toFixed(1),
                    pitch: scene.defaultPitch.toFixed(1),
                    zoom: scene.defaultZoom.toFixed(1),
                  })}
                </div>
                <div>{t("editor.properties.defaultViewHint")}</div>
              </div>
            </div>
          </div>
          <div className="rounded-md border border-border bg-panel px-2.5 py-2 text-[11px] text-muted-foreground">
            {t("editor.properties.hotspotsInSceneCount", { count: scene.hotspots.length })}
          </div>

          {scene.hotspots.length > 0 && (
            <div className="space-y-2 pt-2">
              <Label className="text-xs">{t("editor.properties.hotspotsInScene")}</Label>
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
                          {t("editor.properties.edit")}
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
          {t("editor.properties.noSceneSelected")}
        </p>
      )}

      <div className="border-b border-border px-3 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("editor.properties.hotspotTitle")}
        </h2>
      </div>

      {hotspot ? (
        <div className="space-y-4 p-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("editor.properties.type")}</Label>
            <Select
              value={hotspot.type}
              onValueChange={(v) => onHotspotChange({ type: v as HotspotType })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="door">{t("editor.properties.typeDoor")}</SelectItem>
                <SelectItem value="arrow">{t("editor.properties.typeArrow")}</SelectItem>
                <SelectItem value="info">{t("editor.properties.typeInfo")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("editor.properties.tooltip")}</Label>
            <Input
              className="h-8 text-xs"
              value={hotspot.tooltip}
              onChange={(e) => onHotspotChange({ tooltip: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("editor.properties.pitch")}</Label>
              <Input
                type="number"
                className="h-8 text-xs"
                value={hotspot.pitch}
                onChange={(e) => onHotspotChange({ pitch: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("editor.properties.yaw")}</Label>
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
                <Label className="text-xs">{t("editor.properties.targetScene")}</Label>
                <Select
                  value={hotspot.targetSceneId ?? "none"}
                  onValueChange={(v) => onHotspotChange({ targetSceneId: v === "none" ? null : v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={t("editor.properties.selectScenePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("common.none")}</SelectItem>
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
                      {t("editor.properties.createReturnHotspot")}
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
              <Label className="text-xs">{t("editor.properties.contentMarkdown")}</Label>
              <textarea
                className="w-full h-32 resize-y rounded-md border border-border bg-slate-800 p-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={hotspot.content ?? ""}
                onChange={(e) => onHotspotChange({ content: e.target.value })}
                placeholder={t("editor.properties.contentPlaceholder")}
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
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> {t("editor.properties.deleteHotspot")}
          </Button>
        </div>
      ) : (
        <p className="p-3 text-xs text-muted-foreground">
          {t("editor.properties.selectHotspotHint")}
        </p>
      )}

      <div className="border-y border-border px-3 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("editor.properties.measurementsTitle")}
        </h2>
      </div>

      <div className="space-y-4 p-3">
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-panel px-3 py-2">
          <Label className="text-xs cursor-pointer" htmlFor="show-measurements-export">
            {t("editor.properties.showMeasurementsInExport")}
          </Label>
          <Switch
            id="show-measurements-export"
            checked={showMeasurementsInExport}
            onCheckedChange={onShowMeasurementsInExportChange}
          />
        </div>

        {measurement ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="measurement-label">
                {t("editor.properties.measurementLabel")}
              </Label>
              <Input
                // Remount per measurement so a new line gets focus right away.
                key={measurement.id}
                id="measurement-label"
                autoFocus
                className="h-8 text-xs"
                value={measurement.label}
                placeholder={t("editor.properties.measurementLabelPlaceholder")}
                onChange={(e) => onMeasurementChange({ label: e.target.value })}
              />
            </div>

            {(["a", "b"] as const).map((end) => (
              <MeasurePointFields
                key={end}
                label={
                  end === "a"
                    ? t("editor.properties.measurementPointA")
                    : t("editor.properties.measurementPointB")
                }
                point={measurement[end]}
                onChange={(point) => onMeasurementChange({ [end]: point })}
              />
            ))}

            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              onClick={() => onDeleteMeasurement(measurement.id)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> {t("editor.properties.deleteMeasurement")}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("editor.properties.selectMeasurementHint")}
          </p>
        )}

        {scene && scene.measurements.length > 0 && (
          <div className="space-y-2">
            <Label className="text-xs">{t("editor.properties.measurementsInScene")}</Label>
            {scene.measurements.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md border bg-panel p-2 cursor-pointer",
                  m.id === measurement?.id ? "border-primary" : "border-border",
                )}
                onClick={() => onSelectMeasurement(m.id)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Ruler className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-xs font-medium">
                    {m.label.trim() || t("editor.properties.measurementUnlabeled")}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 w-7 shrink-0 p-0"
                  aria-label={t("editor.properties.deleteMeasurement")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteMeasurement(m.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function MeasurePointFields({
  label,
  point,
  onChange,
}: {
  label: string;
  point: MeasurePoint;
  onChange: (point: MeasurePoint) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="grid grid-cols-2 gap-2">
        <Input
          type="number"
          className="h-8 text-xs"
          aria-label={`${label} ${t("editor.properties.pitch")}`}
          title={t("editor.properties.pitch")}
          value={point.pitch}
          onChange={(e) => onChange({ ...point, pitch: Number(e.target.value) })}
        />
        <Input
          type="number"
          className="h-8 text-xs"
          aria-label={`${label} ${t("editor.properties.yaw")}`}
          title={t("editor.properties.yaw")}
          value={point.yaw}
          onChange={(e) => onChange({ ...point, yaw: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
