import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Me } from "../../../shared/types";
import { get, post, ApiError, isNetworkError } from "./api";

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null!);
const CACHE_KEY = "it:me";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const m = await get<Me>("/auth/me");
      setMe(m);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(m));
      } catch {
        /* noop */
      }
    } catch (e) {
      // オフライン時はキャッシュしたユーザー情報で継続（現場で作業を止めない）
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        try {
          localStorage.removeItem(CACHE_KEY);
        } catch {
          /* noop */
        }
      } else if (!isNetworkError(e)) {
        console.error(e);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await post("/auth/logout").catch(() => {});
    try {
      localStorage.removeItem(CACHE_KEY);
      if ("caches" in window) for (const k of await caches.keys()) if (k.startsWith("api-") || k === "files") await caches.delete(k);
    } catch {
      /* noop */
    }
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
    const h = () => setMe(null);
    window.addEventListener("it:unauthorized", h);
    return () => window.removeEventListener("it:unauthorized", h);
  }, [refresh]);

  return <Ctx.Provider value={{ me, loading, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
