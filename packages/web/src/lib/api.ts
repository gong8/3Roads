const API_BASE = "/api";

export async function apiGet<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  console.log("[3roads:api]", "GET", url);
  const res = await fetch(url);
  console.log("[3roads:api]", "GET", url, "->", res.status);
  if (!res.ok) {
    const errMsg = `API error ${res.status}`;
    console.error("[3roads:api]", "GET", url, "FAILED:", res.status, res.statusText);
    throw new Error(errMsg);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  console.log("[3roads:api]", "POST", url, body !== undefined ? JSON.stringify(body) : "(no body)");
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  console.log("[3roads:api]", "POST", url, "->", res.status);
  if (!res.ok) {
    const errMsg = `API error ${res.status}`;
    console.error("[3roads:api]", "POST", url, "FAILED:", res.status, res.statusText);
    throw new Error(errMsg);
  }
  return res.json();
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  console.log("[3roads:api]", "PATCH", url, JSON.stringify(body));
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log("[3roads:api]", "PATCH", url, "->", res.status);
  if (!res.ok) {
    const errMsg = `API error ${res.status}`;
    console.error("[3roads:api]", "PATCH", url, "FAILED:", res.status, res.statusText);
    throw new Error(errMsg);
  }
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const url = `${API_BASE}${path}`;
  console.log("[3roads:api]", "DELETE", url);
  const res = await fetch(url, { method: "DELETE" });
  console.log("[3roads:api]", "DELETE", url, "->", res.status);
  if (!res.ok) {
    console.error("[3roads:api]", "DELETE", url, "FAILED:", res.status, res.statusText);
    throw new Error(`API error ${res.status}`);
  }
}
