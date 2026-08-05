// Fullscreen toggling for the player surface. The element is identified by id
// so the topbar button and keyboard shortcut can both reach it without
// threading a ref through the component tree.

export const PLAYER_SURFACE_ID = 'player-surface';

export function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    return document.exitFullscreen().catch(() => {});
  }
  const el = document.getElementById(PLAYER_SURFACE_ID);
  if (!el) return Promise.resolve();
  return el.requestFullscreen().catch(() => {});
}
