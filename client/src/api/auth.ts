import type { ApiResponse } from "@ai-novel/shared/types/api";
import { apiClient } from "./client";

export interface AuthSession {
  authenticated: boolean;
  configured: boolean;
  username: string | null;
}

export async function getAuthSession(): Promise<ApiResponse<AuthSession>> {
  const response = await apiClient.get<ApiResponse<AuthSession>>("/auth/session", {
    silentErrorStatuses: [401, 503],
  });
  return response.data;
}

export async function login(username: string, password: string): Promise<ApiResponse<{ username: string }>> {
  const response = await apiClient.post<ApiResponse<{ username: string }>>(
    "/auth/login",
    { username, password },
    { silentErrorStatuses: [400, 401, 429, 503] },
  );
  return response.data;
}

export async function logout(): Promise<void> {
  await apiClient.post("/auth/logout", undefined, { silentErrorStatuses: [401] });
}
