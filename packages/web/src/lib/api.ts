export { API_BASE } from "./base-path";
import { API_BASE } from "./base-path";

/** The signed-in user's Clerk session token for API calls (clerk-js sets window.Clerk). */
export async function authHeaders(): Promise<Record<string, string>> {
  const clerk = (window as { Clerk?: { session?: { getToken(): Promise<string | null> } | null } }).Clerk;
  const token = await clerk?.session?.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiGet<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  console.log("[3roads:api]", "GET", url);
  const res = await fetch(url, { headers: await authHeaders() });
  console.log("[3roads:api]", "GET", url, "->", res.status);
  if (!res.ok) {
    const serverMsg = await res.json().then((b: { error?: string }) => b.error).catch(() => undefined);
    const errMsg = serverMsg ?? `API error ${res.status}`;
    console.error("[3roads:api]", "GET", url, "FAILED:", res.status, res.statusText);
    throw Object.assign(new Error(errMsg), { status: res.status });
  }
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  console.log("[3roads:api]", "POST", url, body !== undefined ? JSON.stringify(body) : "(no body)");
  const res = await fetch(url, {
    method: "POST",
    headers: { ...(await authHeaders()), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  console.log("[3roads:api]", "POST", url, "->", res.status);
  if (!res.ok) {
    const serverMsg = await res.json().then((b: { error?: string }) => b.error).catch(() => undefined);
    const errMsg = serverMsg ?? `API error ${res.status}`;
    console.error("[3roads:api]", "POST", url, "FAILED:", res.status, res.statusText);
    throw Object.assign(new Error(errMsg), { status: res.status });
  }
  return res.json();
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  console.log("[3roads:api]", "PATCH", url, JSON.stringify(body));
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log("[3roads:api]", "PATCH", url, "->", res.status);
  if (!res.ok) {
    const serverMsg = await res.json().then((b: { error?: string }) => b.error).catch(() => undefined);
    const errMsg = serverMsg ?? `API error ${res.status}`;
    console.error("[3roads:api]", "PATCH", url, "FAILED:", res.status, res.statusText);
    throw Object.assign(new Error(errMsg), { status: res.status });
  }
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const url = `${API_BASE}${path}`;
  console.log("[3roads:api]", "DELETE", url);
  const res = await fetch(url, { method: "DELETE", headers: await authHeaders() });
  console.log("[3roads:api]", "DELETE", url, "->", res.status);
  if (!res.ok) {
    console.error("[3roads:api]", "DELETE", url, "FAILED:", res.status, res.statusText);
    throw Object.assign(new Error(`API error ${res.status}`), { status: res.status });
  }
}
