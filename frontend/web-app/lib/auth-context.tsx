"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, apiPost, getToken, removeToken, setToken } from "@/lib/api";

type User = {
  id: string;
  email: string;
  full_name?: string | null;
  role: "citizen" | "researcher" | "policy_maker" | "admin";
  is_active?: boolean;
};

type AuthState = {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, full_name: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = getToken();
    if (!stored) {
      setLoading(false);
      return;
    }
    setTokenState(stored);
    api<User>("/api/v1/auth/me")
      .then((u) => setUser(u))
      .catch(() => {
        removeToken();
        setTokenState(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiPost<{ tokens: { access_token: string }; user: User }>("/api/v1/auth/login", { email, password });
    setToken(res.tokens.access_token);
    setTokenState(res.tokens.access_token);
    setUser(res.user);
  }, []);

  const register = useCallback(async (email: string, password: string, full_name: string) => {
    const res = await apiPost<{ tokens: { access_token: string }; user: User }>("/api/v1/auth/register", {
      email,
      password,
      full_name,
    });
    setToken(res.tokens.access_token);
    setTokenState(res.tokens.access_token);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    await apiPost("/api/v1/auth/logout").catch(() => {});
    removeToken();
    setTokenState(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
