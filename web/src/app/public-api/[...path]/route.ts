import type { NextRequest } from "next/server";

// Same-origin proxy for the visitor portal's API (two-zone rebuild, Phase 5).
//
// The portal is reached from the internet through the tunnel, which exposes
// only this web app's /v/, /_next/ and /public-api/ paths; the backend itself
// is never published. So the visitor's browser talks only to this origin and
// this handler forwards to the backend on the same machine. API_BASE_URL is
// read at request time, like the root layout does, so the installer can move
// the backend port without a rebuild.

export const dynamic = "force-dynamic";

const backend = () => (process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:47102").replace(/\/+$/, "");

async function forward(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = `${backend()}/public-api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  const headers = new Headers();
  for (const name of ["content-type", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The visitor's address, for the backend's rate limit and the audit trail.
  // Cloudflare's header wins when the request came through the tunnel.
  const client = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (client) headers.set("x-forwarded-for", client);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let response: Response;
  try {
    response = await fetch(target, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined, cache: "no-store" });
  } catch {
    return Response.json({ error: "the visitor service is not reachable right now — please try again shortly" }, { status: 502 });
  }
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}

export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
