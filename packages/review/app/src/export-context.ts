import { createContext } from "react";

/** The board version "Export file…" writes, while the board can be exported. */
export interface ExportTarget {
  reviewId: string;
  version: number;
}

export const ExportContext = createContext<ExportTarget | null>(null);
