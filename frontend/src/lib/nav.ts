// Tiny path router. The app has no router dependency: views are derived from
// `location.pathname` here, and every in-app link goes through `navigate()` so
// pushState and the back button stay in sync with the store.

import { client } from '../client';
import { useStore } from '../store';

/** Canonical path of the privacy policy; `/datenschutz` is an alias. */
export const PRIVACY_PATH = '/privacy';
const PRIVACY_PATHS = [PRIVACY_PATH, '/datenschutz'];

export function roomIdFromUrl(): string | null {
  // Hyphens included: registered custom slugs allow them.
  const m = location.pathname.match(/^\/r\/([a-z0-9-]+)$/i);
  return m ? m[1] : null;
}

/** Point the store at whatever the current URL says. */
export function applyRoute() {
  const store = useStore.getState();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const id = roomIdFromUrl();

  // Leaving a room we were seated in (Back, or an in-app link) must actually
  // leave it. Nothing used to: <Room> unmounted but the socket, the 15s ping
  // interval, the 250ms caption tick and the room store all survived, and
  // client.player kept hold of a now-detached <video> — which goes on playing
  // audio, since the DOM does not pause detached media elements. Other
  // participants still saw the seat occupied until the socket eventually died.
  //
  // This lives here rather than in a <Room> unmount effect on purpose:
  // StrictMode double-invokes effects in dev (mount → unmount → mount), so an
  // unmount-driven disconnect would tear down the socket the moment it opened.
  // Routing is the real signal for "the user left".
  if (store.roomId && store.roomId !== id) {
    client.disconnect();
    store.reset();
  }

  if (PRIVACY_PATHS.includes(path)) {
    store.setView('privacy');
    return;
  }

  if (id) {
    // Already seated in this room? Leave the room view alone — a back/forward
    // step that lands on the same URL must not bounce us to the join prompt.
    if (store.view === 'room' && store.roomId === id) return;
    store.setRoomId(id);
    store.setView('nickname');
  } else {
    store.setView('landing');
  }
}

/** Navigate within the SPA (pushState + re-route). */
export function navigate(path: string) {
  if (location.pathname !== path) history.pushState(null, '', path);
  applyRoute();
}
