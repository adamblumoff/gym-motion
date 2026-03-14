const GATEWAY_STORAGE_KEY = "gym-motion.gateway-base-url";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function normalizeGatewayBaseUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const candidate = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const url = new URL(candidate);
    return trimTrailingSlash(url.origin);
  } catch {
    return null;
  }
}

export function readSavedGatewayBaseUrl() {
  if (typeof window === "undefined") {
    return null;
  }

  return normalizeGatewayBaseUrl(
    window.localStorage.getItem(GATEWAY_STORAGE_KEY) ?? "",
  );
}

export function persistGatewayBaseUrl(value: string | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!value) {
    window.localStorage.removeItem(GATEWAY_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(GATEWAY_STORAGE_KEY, value);
}

export function getCurrentOrigin() {
  if (typeof window === "undefined") {
    return null;
  }

  return trimTrailingSlash(window.location.origin);
}

export function buildGatewayUrl(baseUrl: string | null, path: string) {
  const normalizedBaseUrl = normalizeGatewayBaseUrl(baseUrl ?? "");

  if (!normalizedBaseUrl) {
    return path;
  }

  return `${normalizedBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function fetchGatewayJson<T>(
  baseUrl: string | null,
  path: string,
  init?: RequestInit,
) {
  const response = await fetch(buildGatewayUrl(baseUrl, path), {
    ...init,
    cache: init?.cache ?? "no-store",
  });

  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}`);
  }

  return (await response.json()) as T;
}
