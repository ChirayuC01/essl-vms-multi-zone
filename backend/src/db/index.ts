import { PrismaClient } from "@prisma/client";
import { config } from "../config/index.js";

// Single Prisma client for the process. The database is swappable by
// connection string alone; we only supply a configurable default pool size
// when the operator hasn't already pinned one in the URL — everything else
// in the connection string (TLS params, provider extras) passes through
// untouched.
function buildDatasourceUrl(base: string, poolSize: number): string {
  try {
    const u = new URL(base);
    if (!u.searchParams.has("connection_limit")) {
      u.searchParams.set("connection_limit", String(poolSize));
    }
    return u.toString();
  } catch {
    // Unparseable as a URL — hand it to Prisma verbatim rather than risk
    // corrupting a provider-specific string.
    return base;
  }
}

// The cast gives $on("query") a type regardless of whether logging is on.
// Prisma types the client from its log options, and building those
// conditionally would otherwise erase the event signature.
export const prisma = new PrismaClient({
  datasourceUrl: buildDatasourceUrl(config.databaseUrl, config.databasePoolSize),
  ...(config.databaseLogQueries
    ? { log: [{ emit: "event", level: "query" } as const] }
    : {}),
}) as PrismaClient<{ log: [{ emit: "event"; level: "query" }] }>;

/**
 * Count the SQL statements issued while `run` executes.
 *
 * The reason this exists: with a remote database each round trip costs
 * 50-200 ms, so the `getrequest` handler's one-query budget (CLAUDE.md #4) is
 * a correctness property, not an optimisation. Being able to assert it stops
 * a future change from quietly adding a second query to a path that fires
 * every 1-3 seconds per device. Requires DATABASE_LOG_QUERIES=true.
 */
let collector: string[] | null = null;

if (config.databaseLogQueries) {
  // One listener for the process. Prisma's emitter has no off(), so
  // subscribing per call would leak a listener each time.
  prisma.$on("query", (event) => {
    if (collector) collector.push(event.query);
  });
}

export async function countQueries<T>(
  run: () => Promise<T>,
): Promise<{ result: T; queries: string[] }> {
  if (!config.databaseLogQueries) {
    throw new Error("countQueries requires DATABASE_LOG_QUERIES=true");
  }
  if (collector) throw new Error("countQueries cannot be nested");
  const queries: string[] = [];
  collector = queries;
  try {
    const result = await run();
    // Prisma emits query events asynchronously; yield once so the final
    // statement is recorded before the caller inspects the list.
    await new Promise((resolve) => setImmediate(resolve));
    return { result, queries };
  } finally {
    collector = null;
  }
}

export async function assertDatabaseReachable(): Promise<{ serverVersion: string }> {
  const rows =
    await prisma.$queryRaw<Array<{ server_version: string }>>`SHOW server_version`;
  return { serverVersion: rows[0]?.server_version ?? "unknown" };
}

export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
}
