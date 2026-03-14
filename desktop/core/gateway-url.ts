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

export function readSavedGatewayBaseUrl(storage?: Storage) {
  if (!storage) {
    return null;
  }

  return normalizeGatewayBaseUrl(storage.getItem(GATEWAY_STORAGE_KEY) ?? "");
}

export function persistGatewayBaseUrl(value: string | null, storage?: Storage) {
  if (!storage) {
    return;
  }

  if (!value) {
    storage.removeItem(GATEWAY_STORAGE_KEY);
    return;
  }

  storage.setItem(GATEWAY_STORAGE_KEY, value);
}

export function buildGatewayUrl(baseUrl: string | null, path: string) {
  const normalizedBaseUrl = normalizeGatewayBaseUrl(baseUrl ?? "");

  if (!normalizedBaseUrl) {
    return path;
  }

  return `${normalizedBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
