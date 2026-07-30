import type { ApiResponse } from "@ai-novel/shared/types/api";
import type {
  ReferenceBook,
  ReferenceDownloadJob,
  ReferenceSearchJob,
} from "@ai-novel/shared/types/referenceLibrary";
import { API_BASE_URL } from "@/lib/constants";
import { apiClient } from "./client";

export async function createReferenceSearchJob(authors: string[]) {
  const { data } = await apiClient.post<ApiResponse<ReferenceSearchJob>>("/reference-library/search-jobs", { authors });
  return data;
}

export async function getReferenceSearchJob(id: string) {
  const { data } = await apiClient.get<ApiResponse<ReferenceSearchJob>>(`/reference-library/search-jobs/${id}`);
  return data;
}

export async function createReferenceDownloadJobs(searchJobId: string, candidateIds: string[]) {
  const { data } = await apiClient.post<ApiResponse<ReferenceDownloadJob[]>>("/reference-library/download-jobs", {
    searchJobId,
    candidateIds,
  });
  return data;
}

export async function listReferenceDownloadJobs() {
  const { data } = await apiClient.get<ApiResponse<ReferenceDownloadJob[]>>("/reference-library/download-jobs");
  return data;
}

export async function listReferenceBooks(keyword?: string) {
  const { data } = await apiClient.get<ApiResponse<ReferenceBook[]>>("/reference-library/books", { params: { keyword } });
  return data;
}

export async function removeReferenceBookFile(id: string) {
  const { data } = await apiClient.delete<ApiResponse<null>>(`/reference-library/books/${id}/file`);
  return data;
}

export async function redownloadReferenceBook(id: string) {
  const { data } = await apiClient.post<ApiResponse<ReferenceDownloadJob>>(`/reference-library/books/${id}/redownload`, {});
  return data;
}

export async function retryReferenceBookImport(id: string) {
  const { data } = await apiClient.post<ApiResponse<ReferenceBook>>(`/reference-library/books/${id}/retry-import`, {});
  return data;
}

export function getReferenceBookFileUrl(id: string): string {
  return `${API_BASE_URL}/reference-library/books/${encodeURIComponent(id)}/file`;
}
