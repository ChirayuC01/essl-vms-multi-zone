import { NextResponse, type NextRequest } from "next/server";

// Only the visitor portal may be reached through Cloudflare (Phase 9).
//
// The tunnel's path filter is the first line of defence, but it is a
// dashboard setting and easy to get wrong (a quick tunnel has none at all).
// Every request that came through Cloudflare carries CF-Connecting-IP; LAN
// browsers never send it. So anything from Cloudflare that is not a portal
// path — the operator console above all — gets a plain 404 here, whatever
// the tunnel is configured to allow. (A LAN user who sets the header only
// blocks themselves.)

const PORTAL_PATH = /^\/(?:v\/|_next\/|public-api\/|favicon\.ico$)/;

export function proxy(request: NextRequest) {
  if (request.headers.has("cf-connecting-ip") && !PORTAL_PATH.test(request.nextUrl.pathname)) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.next();
}
