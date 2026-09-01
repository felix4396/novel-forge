import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getAuthSession, login as loginRequest, logout as logoutRequest } from "@/api/auth";

export const AUTH_REQUIRED_EVENT = "novel-forge:auth-required";

interface AuthContextValue {
  authenticated: boolean;
  configured: boolean;
  loading: boolean;
  username: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ authenticated: false, configured: true, loading: true, username: null as string | null });

  const refresh = useCallback(async () => {
    try {
      const response = await getAuthSession();
      if (response.data) setState({ ...response.data, loading: false });
    } catch {
      setState((current) => ({ ...current, authenticated: false, loading: false, username: null }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const requireLogin = () => setState((current) => ({ ...current, authenticated: false, username: null }));
    window.addEventListener(AUTH_REQUIRED_EVENT, requireLogin);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, requireLogin);
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const response = await loginRequest(username, password);
    setState({ authenticated: true, configured: true, loading: false, username: response.data?.username ?? username });
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setState((current) => ({ ...current, authenticated: false, username: null }));
    }
  }, []);

  const value = useMemo(() => ({ ...state, login, logout }), [login, logout, state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
