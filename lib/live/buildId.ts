/**
 * Which bundle is running, and which one the server would serve.
 *
 * THE PROBLEM THIS EXISTS FOR. A phone can hold a cached bundle across our
 * deploys — a service worker, an aggressive intermediate cache, an iOS web app
 * that has not been reopened in a week — and then a viewer is running code we
 * stopped shipping, against APIs and playback URLs that have moved on. It
 * looks exactly like "the video does not work on my phone", it is invisible
 * from the server, and the only cure the viewer knows is rebooting the device.
 *
 * So the running bundle carries the commit it was built from, and asks the
 * server what IT is serving. A disagreement is the one situation where
 * reloading the page is not a shot in the dark but the actual fix.
 */

/**
 * The commit this bundle was built from, inlined at build time.
 *
 * Read through next.config's `env` rather than trusting Vercel's automatic
 * NEXT_PUBLIC_ mirror, which depends on a project setting that can be turned
 * off. 'dev' locally, where there is nothing to be stale against.
 */
export const RUNNING_BUILD_ID: string = process.env.NEXT_PUBLIC_BUILD_ID || 'dev';

/** The shape of /api/version. */
export interface VersionResponse {
  buildId: string;
}
