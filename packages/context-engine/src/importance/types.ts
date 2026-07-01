export interface ImportanceSignal {
  score: number; // 0.0 to 1.0
  reason?: string;
}

export interface ImportanceContext {
  isCodeBlock: boolean;
  isLog: boolean;
  isStructuredData: boolean;
}

export interface ImportanceDetector {
  score(line: string, ctx: ImportanceContext): ImportanceSignal | null;
}

export type ImportancePolicy = 'conservative' | 'balanced' | 'aggressive';
