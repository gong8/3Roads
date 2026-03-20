import { createLogger } from "@3roads/shared";

const log = createLogger("mcp:api");
const API_BASE = process.env.API_URL || "http://127.0.0.1:7001";

export async function apiGet<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  log.debug(`GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    log.error(`GET ${url} failed: status=${res.status} body=${text}`);
    throw new Error(`API error ${res.status}: ${text}`);
  }
  const body = await res.json() as T;
  log.debug(`GET ${url} responded ${res.status}`, body);
  return body;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  log.debug(`POST ${url}`, body);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    log.error(`POST ${url} failed: status=${res.status} body=${text}`);
    throw new Error(`API error ${res.status}: ${text}`);
  }
  const responseBody = await res.json() as T;
  log.debug(`POST ${url} responded ${res.status}`, responseBody);
  return responseBody;
}
