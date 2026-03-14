export function applyCorsHeaders(headers: Headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
}

export function withCors<T extends Response>(response: T): T {
  applyCorsHeaders(response.headers);
  return response;
}

export function createCorsPreflightResponse() {
  const response = new Response(null, { status: 204 });
  applyCorsHeaders(response.headers);
  return response;
}
