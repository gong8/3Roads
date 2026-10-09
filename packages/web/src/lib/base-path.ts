const configuredBase = import.meta.env.VITE_BASE_PATH || import.meta.env.BASE_URL;

/** Normalize the one deployment setting for assets, routing, HTTP, audio, and WebSockets. */
export const BASE_PATH = `/${configuredBase.split("/").filter(Boolean).join("/")}${configuredBase === "/" ? "" : "/"}`;

/** React Router and URL construction use the mount path without a trailing slash. */
export const BASE_PATH_PREFIX = BASE_PATH === "/" ? "" : BASE_PATH.slice(0, -1);

export const ROUTER_BASENAME = BASE_PATH_PREFIX || "/";

/** The API is served under /api below the app mount path (dev proxies /api to the API server). */
export const API_BASE = `${BASE_PATH_PREFIX}/api`;
