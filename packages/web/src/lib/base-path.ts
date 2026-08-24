const configuredBase = import.meta.env.VITE_BASE_PATH || import.meta.env.BASE_URL;

/** Normalize the one deployment setting for assets, routing, HTTP, audio, and WebSockets. */
export const BASE_PATH = `/${configuredBase.split("/").filter(Boolean).join("/")}${configuredBase === "/" ? "" : "/"}`;

/** React Router and URL construction use the mount path without a trailing slash. */
export const BASE_PATH_PREFIX = BASE_PATH === "/" ? "" : BASE_PATH.slice(0, -1);

export const ROUTER_BASENAME = BASE_PATH_PREFIX || "/";

/** Local development keeps its existing proxy; deployed requests share the app mount path. */
export const API_BASE = import.meta.env.DEV && BASE_PATH === "/" ? "/api" : BASE_PATH_PREFIX;
