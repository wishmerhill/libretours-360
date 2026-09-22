import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Monitor, Package, Terminal } from "lucide-react";
import type { TourProject } from "@/types/tour";

interface ExportDesktopModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: TourProject;
}

export function ExportDesktopModal({ open, onOpenChange, project }: ExportDesktopModalProps) {
  const { t } = useTranslation();
  const [appName, setAppName] = useState(project.name);
  const [initialSceneId, setInitialSceneId] = useState(
    project.initialSceneId || project.scenes[0]?.id || "",
  );
  const [windowWidth, setWindowWidth] = useState("1280");
  const [windowHeight, setWindowHeight] = useState("800");
  const [fullscreen, setFullscreen] = useState(false);

  // Instructions for the local build — Tauri requires running from a terminal.
  const handleBuild = () => {
    const cmd = `npm run tauri:build`;
    const instructions = [
      t("export.modal.instructions.heading"),
      "",
      `1. ${t("export.modal.instructions.step1")}`,
      `2. ${t("export.modal.instructions.step2", { cmd })}`,
      "",
      t("export.modal.instructions.outputsHeading"),
      "  - src-tauri/target/release/bundle/",
      "",
      t("export.modal.instructions.beforeBuild"),
      `  - app.windows[0].title = "${appName}"`,
      `  - app.windows[0].width = ${windowWidth}`,
      `  - app.windows[0].height = ${windowHeight}`,
      `  - app.windows[0].fullscreen = ${fullscreen}`,
      "",
      t("export.modal.instructions.devMode"),
    ].join("\n");

    // Copy the instructions to the clipboard; the modal stays open so the user can re-copy.
    navigator.clipboard.writeText(instructions).then(() => {});
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            {t("export.modal.title")}
          </DialogTitle>
          <DialogDescription>{t("export.modal.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* App name */}
          <div className="grid gap-2">
            <Label htmlFor="app-name">{t("export.modal.appName")}</Label>
            <Input
              id="app-name"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              placeholder={t("export.modal.appNamePlaceholder")}
            />
          </div>

          {/* Initial scene */}
          <div className="grid gap-2">
            <Label htmlFor="initial-scene">{t("export.modal.initialScene")}</Label>
            <Select value={initialSceneId} onValueChange={setInitialSceneId}>
              <SelectTrigger id="initial-scene">
                <SelectValue placeholder={t("export.modal.selectScene")} />
              </SelectTrigger>
              <SelectContent>
                {project.scenes.map((scene) => (
                  <SelectItem key={scene.id} value={scene.id}>
                    {scene.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Window resolution */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="win-width">{t("export.modal.width")}</Label>
              <Input
                id="win-width"
                type="number"
                min={800}
                max={3840}
                value={windowWidth}
                onChange={(e) => setWindowWidth(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="win-height">{t("export.modal.height")}</Label>
              <Input
                id="win-height"
                type="number"
                min={600}
                max={2160}
                value={windowHeight}
                onChange={(e) => setWindowHeight(e.target.value)}
              />
            </div>
          </div>

          {/* Fullscreen */}
          <div className="flex items-center gap-3">
            <Switch id="fullscreen" checked={fullscreen} onCheckedChange={setFullscreen} />
            <Label htmlFor="fullscreen" className="cursor-pointer">
              {t("export.modal.fullscreen")}
            </Label>
          </div>

          {/* Build instructions */}
          <div className="mt-2 rounded-lg border border-border bg-muted/50 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Terminal className="h-4 w-4" />
              {t("export.modal.localBuild")}
            </div>
            <code className="block rounded bg-background px-3 py-2 text-xs text-muted-foreground">
              npm run tauri:build
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("export.modal.bundlePath")}{" "}
              <code className="rounded bg-background px-1">src-tauri/target/release/bundle/</code>
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("export.modal.close")}
          </Button>
          <Button onClick={handleBuild}>
            <Package className="mr-1.5 h-4 w-4" />
            {t("export.modal.copyInstructions")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
