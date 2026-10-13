import { auth } from "@/lib/auth";
import { isDevelopmentLoginAllowed } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isDevelopmentLoginAllowed(request.headers, request.url)) {
    return Response.json({ error: "Local development login is disabled." }, { status: 403 });
  }
  const url = new URL(request.url);
  url.pathname = "/api/auth/dev-login";
  url.search = "";
  const headers = new Headers(request.headers);
  // This adapter generates its own JSON body, regardless of the browser's empty POST.
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  // Better Auth performs the origin check, creates its session and sets its own cookies.
  return auth.handler(new Request(url, {
    method: "POST",
    headers,
    body: "{}",
  }));
}
