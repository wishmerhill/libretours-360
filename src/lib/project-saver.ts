/**
 * Coordinates saving a project with deleting the image files it no longer uses.
 *
 * The rule: a panorama file is deleted only AFTER a project.json that no longer
 * references it has been written successfully. If the app crashes (or the write
 * fails) in between, the worst outcome is an unused file left on disk, never a
 * project pointing to an image that is gone.
 *
 * Each save takes its snapshot of the project and the list of files queued for
 * deletion at the same moment, so a save that started before a scene was removed
 * can never trigger the deletion of that scene's image.
 */
import type { TourProject } from "@/types/tour";

export interface ProjectSaverDeps {
  /** The latest state of the project being edited. */
  getProject: () => TourProject | null;
  /** Persists a project (validates and writes project.json). */
  save: (project: TourProject) => Promise<TourProject>;
  /** Deletes image files. May throw; never called before a successful save. */
  deleteAssets: (projectId: string, refs: string[]) => Promise<void>;
  /** Called when files could not be deleted after a successful save (they are not retried). */
  onAssetDeleteError?: (error: unknown, refs: string[]) => void;
}

export class ProjectSaver {
  private readonly deps: ProjectSaverDeps;
  private dirty = false;
  private pendingDeletes: string[] = [];

  constructor(deps: ProjectSaverDeps) {
    this.deps = deps;
  }

  /** The user changed something that has not been written yet. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Forget all pending work (a different project was loaded). */
  reset(): void {
    this.dirty = false;
    this.pendingDeletes = [];
  }

  /** True if there are unsaved edits or files waiting to be deleted. */
  get needsSave(): boolean {
    return this.dirty || this.pendingDeletes.length > 0;
  }

  /**
   * Queue image files for deletion. Call it AFTER the project state no longer
   * references them; they are deleted once a save containing that state succeeds.
   */
  queueAssetDeletion(refs: string[]): void {
    this.pendingDeletes.push(...refs);
    this.dirty = true;
  }

  /**
   * Saves the project if needed (or always with `force`), then deletes the queued
   * files. Returns the saved project, or null if there was nothing to do.
   * If the save fails the error is thrown, nothing is deleted, and everything
   * stays pending for the next attempt.
   */
  async flush(options: { force?: boolean } = {}): Promise<TourProject | null> {
    const project = this.deps.getProject();
    if (!project) return null;
    if (!options.force && !this.needsSave) return null;

    const doomed = this.pendingDeletes.splice(0);
    this.dirty = false;

    let saved: TourProject;
    try {
      saved = await this.deps.save(project);
    } catch (e) {
      this.dirty = true;
      this.pendingDeletes.unshift(...doomed);
      throw e;
    }

    if (doomed.length > 0) {
      try {
        await this.deps.deleteAssets(project.id, doomed);
      } catch (e) {
        this.deps.onAssetDeleteError?.(e, doomed);
      }
    }
    return saved;
  }
}
