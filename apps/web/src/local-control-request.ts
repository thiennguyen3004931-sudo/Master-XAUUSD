const CONTROL_DIRECT = "http://127.0.0.1:3711";

type FetchLike = typeof fetch;

function requestMethod(init?: RequestInit): string {
  return (init?.method ?? "GET").trim().toUpperCase();
}

function isReadOnlyMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) {
    throw new Error(payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`);
  }
  return payload as T;
}

export async function requestLocalControlJson<T>(
  path: string,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const method = requestMethod(init);
  const urls = isReadOnlyMethod(method)
    ? [path, `${CONTROL_DIRECT}${path}`]
    : [path];
  const errors: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { cache: "no-store", ...init });
      return await readJson<T>(response);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Không kết nối được");
    }
  }

  throw new Error(errors.join(" | "));
}
