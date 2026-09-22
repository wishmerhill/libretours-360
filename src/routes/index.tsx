import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Compass,
  Copy,
  Download,
  FileJson,
  Image as ImageIcon,
  Layers,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import type { TourProject } from "@/types/tour";
import { createProject } from "@/types/tour";
import {
  deleteProject,
  duplicateProject,
  importProjectJson,
  loadProjects,
  upsertProject,
} from "@/lib/storage";
import { ProjectValidationError, describeStorageError } from "@/lib/storage-errors";
import { resolveThumbnailUrl } from "@/lib/assets";
import { exportJson } from "@/lib/export";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "LibreTours 360 — 360° Virtual Tour Creator" },
      {
        name: "description",
        content:
          "Build, edit and export interactive 360° virtual tours in your browser. Local-first panorama editor with hotspots, scenes and ZIP export.",
      },
      { property: "og:title", content: "LibreTours 360 — 360° Virtual Tour Creator" },
      {
        property: "og:description",
        content:
          "Local-first 360° tour editor: drop in panoramas, link scenes with hotspots, export a standalone viewer.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<TourProject[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadProjects()
      .then(setProjects)
      .catch((e) => {
        console.error("Could not load projects", e);
        toast.error(t("dashboard.toasts.loadFailed"), { description: describeStorageError(e) });
      });
    // Load once on mount; `t` always resolves against the current language when called,
    // so this must not re-run (and refetch projects) on a language change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const entries: Record<string, string> = {};
      for (const project of projects) {
        const first = project.scenes[0];
        if (!first?.panoramaUrl) continue;
        try {
          entries[project.id] = await resolveThumbnailUrl(project.id, first.panoramaUrl);
        } catch (e) {
          // A missing preview must not break the whole dashboard.
          console.warn(`No preview for project ${project.id}`, e);
        }
      }
      if (active) setThumbs(entries);
    })();
    return () => {
      active = false;
    };
  }, [projects]);

  const handleNew = () => {
    const project = createProject("LibreTours 360");
    upsertProject(project)
      .then(() => {
        navigate({ to: "/editor/$id", params: { id: project.id } });
      })
      .catch((e) => {
        console.error("Could not create project", e);
        toast.error(t("dashboard.toasts.createFailed"), { description: describeStorageError(e) });
      });
  };

  const handleImport = async (file: File) => {
    let project: TourProject;
    try {
      project = importProjectJson(await file.text());
    } catch (e) {
      console.error("Import rejected", e);
      toast.error(t("dashboard.toasts.invalidFile"), {
        description:
          e instanceof ProjectValidationError ? e.message : t("dashboard.toasts.fileUnreadable"),
      });
      return;
    }
    try {
      // Only ever writes the imported project; existing projects are untouched.
      await upsertProject(project);
      setProjects(await loadProjects());
      toast.success(t("dashboard.toasts.imported", { name: project.name }));
    } catch (e) {
      console.error("Import failed", e);
      toast.error(t("dashboard.toasts.importSaveFailed"), {
        description: describeStorageError(e),
      });
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-sidebar/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Compass className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold tracking-tight">{t("dashboard.brand")}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitcher />
            <Button variant="secondary" size="sm" onClick={() => importRef.current?.click()}>
              <Upload className="mr-1.5 h-3.5 w-3.5" /> {t("dashboard.importJson")}
            </Button>
            <input
              ref={importRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleImport(file);
                e.target.value = "";
              }}
            />
            <Button size="sm" onClick={handleNew}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> {t("dashboard.newProject")}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="text-xl font-semibold tracking-tight">{t("dashboard.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.subtitle")}</p>

        {projects.length === 0 ? (
          <div className="mt-10 rounded-xl border border-dashed border-border bg-card/60 px-6 py-16 text-center">
            <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Compass className="h-6 w-6" />
            </span>
            <h2 className="text-base font-semibold">{t("dashboard.emptyTitle")}</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              {t("dashboard.emptyHint")}
            </p>
            <Button className="mt-5" onClick={handleNew}>
              <Plus className="mr-1.5 h-4 w-4" /> {t("dashboard.createFirstTour")}
            </Button>
          </div>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <article
                key={project.id}
                className="group overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-primary/60"
              >
                <div className="relative aspect-video bg-panel">
                  {thumbs[project.id] ? (
                    <img
                      src={thumbs[project.id]}
                      alt={t("dashboard.thumbnailAlt", { name: project.name })}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      <ImageIcon className="h-6 w-6" />
                    </div>
                  )}
                  <Badge className="absolute left-2 top-2 bg-primary/90 text-[10px]">360°</Badge>
                  <Badge variant="secondary" className="absolute right-2 top-2 gap-1 text-[10px]">
                    <Layers className="h-3 w-3" /> {project.scenes.length}
                  </Badge>
                </div>
                <div className="flex items-start gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold">{project.name}</h2>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("dashboard.modified", {
                        date: new Date(project.updatedAt).toLocaleDateString(i18n.language),
                        time: new Date(project.updatedAt).toLocaleTimeString(i18n.language, {
                          hour: "2-digit",
                          minute: "2-digit",
                        }),
                      })}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" className="h-7 w-7">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        onClick={() => navigate({ to: "/editor/$id", params: { id: project.id } })}
                      >
                        <Pencil className="mr-2 h-3.5 w-3.5" /> {t("dashboard.menu.edit")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={async () => {
                          try {
                            if (!(await duplicateProject(project.id))) {
                              toast.error(t("dashboard.toasts.projectNotFound"));
                              return;
                            }
                            setProjects(await loadProjects());
                            toast.success(t("dashboard.toasts.duplicated"));
                          } catch (e) {
                            console.error("Duplicate failed", e);
                            toast.error(t("dashboard.toasts.duplicateFailed"), {
                              description: describeStorageError(e),
                            });
                          }
                        }}
                      >
                        <Copy className="mr-2 h-3.5 w-3.5" /> {t("dashboard.menu.duplicate")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => exportJson(project)}>
                        <FileJson className="mr-2 h-3.5 w-3.5" /> {t("dashboard.menu.exportJson")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={async () => {
                          try {
                            await deleteProject(project.id);
                            setProjects(await loadProjects());
                            toast.success(t("dashboard.toasts.deleted"));
                          } catch (e) {
                            console.error("Delete failed", e);
                            toast.error(t("dashboard.toasts.deleteFailed"), {
                              description: describeStorageError(e),
                            });
                          }
                        }}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" /> {t("dashboard.menu.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex gap-2 border-t border-border p-3">
                  <Button asChild size="sm" className="flex-1">
                    <Link to="/editor/$id" params={{ id: project.id }}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" /> {t("dashboard.menu.edit")}
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => exportJson(project)}
                    title={t("dashboard.menu.exportJson")}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
