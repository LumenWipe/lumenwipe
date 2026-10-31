import "server-only";
import { NextResponse } from "next/server";
import { proxyErrorResponse } from "@/lib/api/proxy-error";

/**
 * Runs a server-side SDK call and turns it into a NextResponse, re-emitting the
 * upstream API's error body + status verbatim so the browser sees exactly what
 * the API returned. The API is the single source of validation and behavior;
 * these route handlers only inject the key and relay.
 */
export async function proxy<T>(
  fn: () => Promise<T>,
  cacheControl = "no-store"
): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data, { headers: { "Cache-Control": cacheControl } });
  } catch (e) {
    return proxyErrorResponse(e);
  }
}
