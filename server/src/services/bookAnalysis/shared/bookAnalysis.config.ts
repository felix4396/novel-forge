import { DEFAULT_BOOK_ANALYSIS_BUDGET_TOKENS } from "@ai-novel/shared/types/bookAnalysis";

export const NOTES_PROGRESS_SHARE = 0.45;
export const SECTION_PROGRESS_SHARE = 0.55;
export const LOADING_CACHE_PROGRESS = 0.02;

export function getBookAnalysisMaxConcurrentTasks(): number {
  return 2;
}

export function getBookAnalysisNotesConcurrency(): number {
  return 2;
}

export function getBookAnalysisSectionConcurrency(): number {
  return 2;
}

export function getBookAnalysisAppearanceScanConcurrency(): number {
  return 2;
}

export function getBookAnalysisAppearanceChapterConcurrency(): number {
  return 6;
}

export function getBookAnalysisDefaultBudgetTokens(): number {
  return DEFAULT_BOOK_ANALYSIS_BUDGET_TOKENS;
}

export function getBookAnalysisCacheSegmentVersion(): number {
  return 1;
}
