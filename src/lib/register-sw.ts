/**
 * registerSW — registers the Beam app-shell service worker.
 *
 * Only registers in production builds (`NODE_ENV === 'production'`) and only
 * in the browser (guards for SSR / non-SW environments). The SW itself is a
 * plain static file served from `/sw.js` at the site root.
 *
 * Usage from a React effect (e.g. inside the root layout):
 *
 *   import { useEffect } from 'react';
 *   import { registerSW } from '@/lib/register-sw';
 *
 *   export function RootLayout({ children }) {
 *     useEffect(() => { registerSW(); }, []);
 *     return <>{children}</>;
 *   }
 *
 * Or, since the default export IS that effect-ready form:
 *
 *   import registerSWEffect from '@/lib/register-sw';
 *   // ...
 *   useEffect(registerSWEffect, []);
 */

export interface RegisterSWResult {
  /** The ServiceWorkerRegistration if registration succeeded, otherwise null. */
  registration: ServiceWorkerRegistration | null;
  /** Any error encountered, otherwise null. */
  error: unknown;
}

/**
 * Register `/sw.js`. Safe to call during SSR — it will no-op on the server.
 * Returns a promise that resolves to the registration (or null/error), so it
 * can also be awaited by non-React callers.
 */
export async function registerSW(): Promise<RegisterSWResult> {
  // SSR / non-browser guard — `navigator` & `window` are not available on the server.
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { registration: null, error: null };
  }

  // Only register in production builds. During `next dev` the SW would cache
  // stale chunks and fight HMR, so we skip it entirely.
  if (process.env.NODE_ENV !== 'production') {
    return { registration: null, error: null };
  }

  // No ServiceWorker support — nothing to do.
  if (!('serviceWorker' in navigator)) {
    return { registration: null, error: null };
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      // updateViaCache: 'none' — always fetch the SW script fresh so updates land ASAP.
      updateViaCache: 'none',
    });

    console.info('[beam] service worker registered', registration.scope);

    return { registration, error: null };
  } catch (error) {
    console.warn('[beam] service worker registration failed', error);
    return { registration: null, error };
  }
}

/**
 * Effect-friendly default export: a zero-arg function suitable for passing
 * directly to `useEffect(registerSW, [])`.
 */
export default function registerSWEffect(): void {
  void registerSW();
}
