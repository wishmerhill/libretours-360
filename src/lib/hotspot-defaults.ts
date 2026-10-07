/**
 * Editor behaviour for hotspot defaults.
 *
 * Placeholder for a future settings page: these values are constants today, but
 * they are read through `getHotspotDefaults()` so a user-configurable source
 * (app preferences, per-project settings) can be plugged in without touching
 * the call sites.
 */
export interface HotspotDefaults {
  /**
   * When a door or arrow hotspot gets a target scene, set its tooltip to
   * "Go to {scene}" - unless the user already typed a custom tooltip.
   */
  autoTooltipOnTarget: boolean;
}

const BUILT_IN_DEFAULTS: HotspotDefaults = {
  autoTooltipOnTarget: true,
};

// TODO(settings): read from the future configuration page instead of the built-in values.
export function getHotspotDefaults(): HotspotDefaults {
  return BUILT_IN_DEFAULTS;
}
