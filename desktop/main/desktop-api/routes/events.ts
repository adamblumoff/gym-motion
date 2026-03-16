import http from "node:http";

import { listRecentEvents } from "../../../../backend/data";
import { json } from "../http";

export async function handleEventRoutes(args: {
  response: http.ServerResponse;
  pathname: string;
  method: string;
  url: URL;
}) {
  const { response, pathname, method, url } = args;

  if (method === "GET" && pathname === "/api/events") {
    const limit = Number(url.searchParams.get("limit") ?? "12");
    json(response, 200, { events: await listRecentEvents(limit) });
    return true;
  }

  return false;
}
