import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type {
  ThemeOverlayAnchor,
  ThemeOverlayElement,
  ThemeOverlayElementStyle,
  ThemeOverlayOffsetUnit,
} from "@/types/tour";
import { resolveThemeAssetUrl } from "@/lib/theme-assets";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Formats accepted by the overlay image picker (same as the logo picker). */
const IMAGE_ACCEPT = "image/png,image/svg+xml,image/jpeg,image/webp";

const ANCHORS: ThemeOverlayAnchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

interface Props {
  projectId: string;
  element: ThemeOverlayElement | null;
  onChange: (patch: Partial<ThemeOverlayElement>) => void;
  onStyleChange: (patch: Partial<ThemeOverlayElementStyle>) => void;
  onImageFileSelected: (file: File) => void;
  onDelete: () => void;
}

export function ThemeElementEditor({
  projectId,
  element,
  onChange,
  onStyleChange,
  onImageFileSelected,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState("");

  const content = element?.type !== "text" ? element?.content : undefined;
  useEffect(() => {
    if (!projectId || !content) {
      setImagePreviewUrl("");
      return;
    }
    let active = true;
    (async () => {
      const url = await resolveThemeAssetUrl(projectId, content);
      if (active) setImagePreviewUrl(url);
    })();
    return () => {
      active = false;
    };
  }, [projectId, content]);

  return (
    <aside className="flex w-76 shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar">
      <div className="border-b border-border px-3 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("editor.theme.elements.panelTitle")}
        </h2>
      </div>

      {!element ? (
        <p className="p-3 text-xs text-muted-foreground">
          {t("editor.theme.elements.noSelection")}
        </p>
      ) : (
        <div className="space-y-4 p-3">
          {element.type === "text" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("editor.theme.elements.content")}</Label>
                <textarea
                  className="h-20 w-full resize-y rounded-md border border-border bg-slate-800 p-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  value={element.content}
                  onChange={(e) => onChange({ content: e.target.value })}
                />
                <p className="text-[10px] text-muted-foreground">
                  {t("editor.theme.elements.variablesHint", {
                    sceneVar: "{{scene.title}}",
                    projectVar: "{{project.name}}",
                  })}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("editor.theme.elements.textColor")}</Label>
                  <Input
                    type="color"
                    className="h-8 w-full p-1"
                    value={element.style.color ?? "#f4f4f5"}
                    onChange={(e) => onStyleChange({ color: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("editor.theme.elements.bgColor")}</Label>
                  <Input
                    type="color"
                    className="h-8 w-full p-1"
                    value={toHexColor(element.style.backgroundColor)}
                    onChange={(e) => onStyleChange({ backgroundColor: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("editor.theme.elements.fontSize")}</Label>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={element.style.fontSize ?? 14}
                    onChange={(e) => onStyleChange({ fontSize: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("editor.theme.elements.borderRadius")}</Label>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={element.style.borderRadius ?? 0}
                    onChange={(e) => onStyleChange({ borderRadius: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("editor.theme.elements.padding")}</Label>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={element.style.padding ?? 0}
                    onChange={(e) => onStyleChange({ padding: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("editor.theme.elements.opacity")}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.1}
                    className="h-8 text-xs"
                    value={element.style.opacity ?? 1}
                    onChange={(e) => onStyleChange({ opacity: Number(e.target.value) })}
                  />
                </div>
              </div>
            </>
          )}

          {element.type === "image" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("editor.theme.elements.image")}</Label>
                {imagePreviewUrl ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-panel p-2">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                      <img src={imagePreviewUrl} alt="" className="h-full w-full object-contain" />
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 flex-1 text-xs"
                      onClick={() => imageInputRef.current?.click()}
                    >
                      {t("editor.theme.elements.replaceImage")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 w-full text-xs"
                    onClick={() => imageInputRef.current?.click()}
                  >
                    {t("editor.theme.elements.chooseImage")}
                  </Button>
                )}
                <input
                  ref={imageInputRef}
                  type="file"
                  accept={IMAGE_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) onImageFileSelected(file);
                    e.target.value = "";
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("editor.theme.elements.width")}</Label>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={element.style.width ?? 80}
                    onChange={(e) => onStyleChange({ width: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("editor.theme.elements.height")}</Label>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={element.style.height ?? 80}
                    onChange={(e) => onStyleChange({ height: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("editor.theme.elements.opacity")}</Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  className="h-8 text-xs"
                  value={element.style.opacity ?? 1}
                  onChange={(e) => onStyleChange({ opacity: Number(e.target.value) })}
                />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">{t("editor.theme.elements.anchor")}</Label>
            <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-border bg-panel p-2">
              {ANCHORS.map((anchor) => (
                <button
                  key={anchor}
                  type="button"
                  title={t(`editor.theme.elements.anchors.${anchor}`)}
                  onClick={() => onChange({ position: anchor })}
                  className={cn(
                    "flex h-9 items-center justify-center rounded-md border transition-colors",
                    element.position === anchor
                      ? "border-primary bg-primary/15"
                      : "border-transparent bg-background/60 hover:border-border",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      element.position === anchor ? "bg-primary" : "bg-muted-foreground",
                    )}
                  />
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("editor.theme.elements.offsetX")}</Label>
              <Input
                type="number"
                className="h-8 text-xs"
                value={element.offsetX}
                onChange={(e) => onChange({ offsetX: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("editor.theme.elements.offsetY")}</Label>
              <Input
                type="number"
                className="h-8 text-xs"
                value={element.offsetY}
                onChange={(e) => onChange({ offsetY: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("editor.theme.elements.unit")}</Label>
            <Select
              value={element.offsetUnit}
              onValueChange={(v) => onChange({ offsetUnit: v as ThemeOverlayOffsetUnit })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="px">px</SelectItem>
                <SelectItem value="%">%</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button variant="destructive" size="sm" className="w-full" onClick={onDelete}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> {t("editor.theme.elements.deleteElement")}
          </Button>
        </div>
      )}
    </aside>
  );
}

/** A color <input> needs a #rrggbb value; falls back to a neutral dark shade for rgba()/named/unset colors. */
function toHexColor(value: string | undefined): string {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#18181b";
}
