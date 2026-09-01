import type { ReactNode } from "react";
import LoginPage from "@/pages/auth/LoginPage";
import { useAuth } from "./AuthContext";

export default function AuthGate({ children }: { children: ReactNode }) {
  const { authenticated, configured, loading } = useAuth();
  if (loading) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background text-sm text-muted-foreground">正在检查登录状态...</div>;
  }
  if (!authenticated) return <LoginPage configured={configured} />;
  return children;
}
