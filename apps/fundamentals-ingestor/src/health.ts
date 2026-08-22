/**
 * Health & coverage tracking for the fundamentals ingestor.
 */

export interface CoverageStats {
  readonly total: number;
  readonly complete: number;
  readonly partial: number;
  readonly missing: number;
}

export interface SymbolCoverage {
  readonly symbol: string;
  readonly latestPeriod: string | null;
  readonly missingFields: string[];
  readonly blockers: string[];
  readonly quality: "complete" | "partial" | "none";
}

export function computeCoverageStats(coverage: SymbolCoverage[]): CoverageStats {
  let complete = 0;
  let partial = 0;
  let missing = 0;
  for (const c of coverage) {
    if (c.quality === "complete") complete++;
    else if (c.quality === "partial") partial++;
    else missing++;
  }
  return { total: coverage.length, complete, partial, missing };
}

export function formatCoverageReport(stats: CoverageStats): string {
  return `Complete: ${stats.complete}/${stats.total}  Partial: ${stats.partial}/${stats.total}  Missing: ${stats.missing}/${stats.total}`;
}
