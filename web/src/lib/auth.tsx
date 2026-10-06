"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "./api";

// Session state for the operator console.
//
// The token lives in localStorage rather than an httpOnly cookie: this is an
// on-premise LAN tool with no cross-site surface, and EventSource cannot send
// an Authorization header, so the SSE stream needs a token the client can
// read. Revisit if the console is ever exposed beyond the LAN.
//
// Permissions come from the server on every load and are used only to decide
// what to render. The API enforces them independently; a client that ignored
// this entirely would still be refused.

export interface Operator {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: string;
  createdAt?: string | null;
  passwordChangedAt?: string | null;
  /** What this role may do. Sent by the server; never inferred client-side. */
  permissions?: string[];
  mustChangePassword?: boolean;
}

interface AuthState {
  user: Operator | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  /**
   * Whether the signed-in operator holds a permission.
   *
   * Used ONLY to decide what to show. The API enforces the same rules and is
   * the actual boundary — hiding a button an operator may not use is courtesy,
   * not security, and treating it as security is how client-side checks end up
   * load-bearing.
   */
  can: (permission: string) => boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Operator | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // Resolve the stored token against the server on load — a token that is
  // expired, or signed with a secret the backend no longer uses, must not
  // look like a valid session.
  useEffect(() => {
    // The visitor portal has no operator session; asking would bounce the
    // visitor to the console's sign-in page. Nothing on the portal reads
    // the session, so it is simply never resolved there.
    if (window.location.pathname.startsWith("/v/")) return;
    let cancelled = false;
    api<Operator>("/api/auth/me")
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    const me = await api<Operator>("/api/auth/me");
    setUser(me);
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await api<{ token: string; user: Operator; mustChangePassword?: boolean }>(
        "/api/auth/login",
        { method: "POST", body: { email, password } },
      );
      setToken(result.token);
      // Re-read from /auth/me so permissions come from one place rather than
      // being assembled differently at login than on reload.
      const me = await api<Operator>("/api/auth/me");
      setUser(me);
      router.push(me.mustChangePassword ? "/change-password" : "/");
    },
    [router],
  );

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    router.push("/login");
  }, [router]);

  const can = useCallback(
    (permission: string) => user?.permissions?.includes(permission) ?? false,
    [user],
  );

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, can, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
