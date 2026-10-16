/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_BASE_PATH?: string;
	readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
	/** Set by vite.config from the repo-root LOCAL_AUTH; always false in production builds. */
	readonly VITE_LOCAL_AUTH: boolean;
}
