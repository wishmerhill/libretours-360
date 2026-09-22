import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image as ImageIcon, Layers, Map, Palette, Plus, Trash2, Upload } from "lucide-react";
import type { Scene, Theme } from "@/types/tour";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { hasNativeImport } from "@/lib/panorama-import";

interface Props {
  scenes: Scene[];
  sceneUrls: Record<string, string>;
  activeSceneId: string | null;
  initialSceneId: string | null;
  theme: Theme;
  onSelectScene: (id: string) => void;
  onDeleteScene: (id: string) => void;
  onSetInitialScene: (id: string) => void;
  onFiles: (files: FileList | File[]) => void;
  /** Tauri: open the native file dialog (files are copied natively, not read into memory). */
  onPickNative: () => void;
  onThemeChange: (patch: Partial<Theme>) => void;
}

export function LeftSidebar({
  scenes,
  sceneUrls,
  activeSceneId,
  initialSceneId,
  theme,
  onSelectScene,
  onDeleteScene,
  onSetInitialScene,
  onFiles,
  onPickNative,
  onThemeChange,
}: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-sidebar">
      <Tabs defaultValue="scenes" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="h-10 w-full justify-start rounded-none border-b border-border bg-transparent p-0">
          <TabsTrigger value="scenes" className="h-10 flex-1 gap-1.5 rounded-none text-xs">
            <Layers className="h-3.5 w-3.5" /> {t("editor.sidebar.tabs.scenes")}
          </TabsTrigger>
          <TabsTrigger value="theme" className="h-10 flex-1 gap-1.5 rounded-none text-xs">
            <Palette className="h-3.5 w-3.5" /> {t("editor.sidebar.tabs.theme")}
          </TabsTrigger>
          <TabsTrigger value="floorplans" className="h-10 flex-1 gap-1.5 rounded-none text-xs">
            <Map className="h-3.5 w-3.5" /> {t("editor.sidebar.tabs.plans")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scenes" className="m-0 min-h-0 flex-1 overflow-y-auto p-3">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
            }}
            className={cn(
              "mb-3 rounded-lg border border-dashed p-4 text-center transition-colors",
              dragOver ? "border-primary bg-primary/10" : "border-border bg-panel",
            )}
          >
            <Upload className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{t("editor.sidebar.dropHint")}</p>
            <Button
              size="sm"
              className="mt-3 w-full"
              onClick={() => (hasNativeImport() ? onPickNative() : inputRef.current?.click())}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> {t("editor.sidebar.addScene")}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) onFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <div className="space-y-2">
            {scenes.length === 0 && (
              <p className="px-1 text-xs text-muted-foreground">{t("editor.sidebar.noScenes")}</p>
            )}
            {scenes.map((scene) => (
              <div
                key={scene.id}
                onClick={() => onSelectScene(scene.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-lg border p-2 transition-colors",
                  scene.id === activeSceneId
                    ? "border-primary bg-primary/10"
                    : "border-border bg-panel hover:border-primary/50",
                )}
              >
                <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-muted">
                  {sceneUrls[scene.id] ? (
                    <img
                      src={sceneUrls[scene.id]}
                      alt={scene.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="m-auto mt-2.5 h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{scene.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {t("editor.sidebar.hotspotsCount", { count: scene.hotspots.length })}
                    {scene.id === initialSceneId ? ` · ${t("editor.sidebar.startBadge")}` : ""}
                  </p>
                </div>
                <div className="flex flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    title={t("editor.sidebar.setAsStartScene")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSetInitialScene(scene.id);
                    }}
                  >
                    <Map className="h-3 w-3" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-destructive"
                    title={t("editor.sidebar.deleteScene")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteScene(scene.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="theme" className="m-0 min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          <div className="flex items-center justify-between rounded-lg border border-border bg-panel p-3">
            <div>
              <p className="text-xs font-medium">{t("editor.sidebar.theme.showNavbar")}</p>
              <p className="text-[10px] text-muted-foreground">
                {t("editor.sidebar.theme.showNavbarHint")}
              </p>
            </div>
            <Switch
              checked={theme.showNavbar}
              onCheckedChange={(v) => onThemeChange({ showNavbar: v })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border bg-panel p-3">
            <div>
              <p className="text-xs font-medium">{t("editor.sidebar.theme.titleOverlay")}</p>
              <p className="text-[10px] text-muted-foreground">
                {t("editor.sidebar.theme.titleOverlayHint")}
              </p>
            </div>
            <Switch
              checked={theme.showTitleOverlay}
              onCheckedChange={(v) => onThemeChange({ showTitleOverlay: v })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("editor.sidebar.theme.logoUrl")}</Label>
            <Input
              className="h-8 text-xs"
              placeholder="https://…/logo.svg"
              value={theme.logoUrl}
              onChange={(e) => onThemeChange({ logoUrl: e.target.value })}
            />
            <p className="text-[10px] text-muted-foreground">
              {t("editor.sidebar.theme.logoUrlHint")}
            </p>
          </div>
        </TabsContent>

        <TabsContent value="floorplans" className="m-0 min-h-0 flex-1 overflow-y-auto p-3">
          <div className="rounded-lg border border-dashed border-border bg-panel p-6 text-center">
            <Map className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-xs font-medium">{t("editor.sidebar.floorplans.title")}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("editor.sidebar.floorplans.hint")}
            </p>
            <Button size="sm" variant="secondary" className="mt-3 w-full" disabled>
              {t("editor.sidebar.floorplans.add")}
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
