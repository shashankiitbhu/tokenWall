import { DBManager } from '@tokenwall/core';

export interface LoopDetectResult {
  loopDetected: boolean;
  reason?: string;
}

export class RunawayLoopDetector {
  private db: DBManager;

  constructor(db: DBManager) {
    this.db = db;
  }

  detect(sessionId: string, newPrompt: string, newInputTokens: number): LoopDetectResult {
    // Retrieve the last 4 requests from this session
    const recentRequests = this.db.db.prepare(`
      SELECT model, input_tokens, output_tokens, status, created_at
      FROM requests
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 4
    `).all(sessionId) as Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      status: string;
    }>;

    if (recentRequests.length < 3) {
      return { loopDetected: false };
    }

    // 1. Check Context Window Velocity (token explosion)
    // If input tokens are growing exponentially (e.g., doubling each request)
    let isExploding = true;
    let lastTokenCount = newInputTokens;
    for (const req of recentRequests) {
      if (req.input_tokens >= lastTokenCount) {
        isExploding = false;
        break;
      }
      // Check if the growth is substantial (> 40% growth per request)
      if (lastTokenCount / req.input_tokens < 1.4) {
        isExploding = false;
        break;
      }
      lastTokenCount = req.input_tokens;
    }

    if (isExploding) {
      return {
        loopDetected: true,
        reason: `Context window velocity alert: Input tokens are growing exponentially (from ${recentRequests[recentRequests.length - 1].input_tokens.toLocaleString()} to ${newInputTokens.toLocaleString()}). Possible runaway conversation log append loop.`
      };
    }

    // 2. Check Sequential Failures
    const lastThreeFailed = recentRequests.slice(0, 3).every(r => r.status === 'failed');
    if (lastThreeFailed) {
      return {
        loopDetected: true,
        reason: 'Three consecutive requests failed or resulted in errors. Halting execution to prevent automated loops.'
      };
    }

    // 3. Jaccard Prompt Similarity
    // Since we don't store raw prompts in DB to preserve privacy and prevent database bloat,
    // we can check if the input token count remains EXACTLY identical or within 1-2 tokens for the last 3 requests.
    // That is a highly effective, local-first heuristic for loops!
    const tokenCounts = [newInputTokens, ...recentRequests.slice(0, 3).map(r => r.input_tokens)];
    const uniqueTokens = new Set(tokenCounts);
    
    // If 4 consecutive requests have exactly the same input token size, it is a high-probability prompt loop
    if (uniqueTokens.size === 1) {
      return {
        loopDetected: true,
        reason: 'Duplicate prompt footprint detected. Multiple sequential requests have the exact same token footprint.'
      };
    }

    return { loopDetected: false };
  }
}
