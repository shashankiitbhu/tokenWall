"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunawayLoopDetector = void 0;
class RunawayLoopDetector {
    db;
    constructor(db) {
        this.db = db;
    }
    detect(sessionId, newPrompt, newInputTokens) {
        // Retrieve the last 4 requests from this session
        const recentRequests = this.db.db.prepare(`
      SELECT model, input_tokens, output_tokens, status, created_at
      FROM requests
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 4
    `).all(sessionId);
        if (recentRequests.length < 3) {
            return { loopDetected: false };
        }
        // Reset loop detection if the last request was more than 60 seconds ago (quiet period threshold)
        if (recentRequests.length > 0) {
            const lastRequestTime = new Date(recentRequests[0].created_at + ' UTC').getTime();
            const currentTime = Date.now();
            const secondsSinceLastRequest = (currentTime - lastRequestTime) / 1000;
            if (secondsSinceLastRequest > 60) {
                return { loopDetected: false };
            }
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
                reason: `Loop Protection: Context window velocity alert. Input tokens are growing exponentially (from ${recentRequests[recentRequests.length - 1].input_tokens.toLocaleString()} to ${newInputTokens.toLocaleString()}), indicating a runaway conversation log append loop. (Bypass: Wait 60s for a quiet period reset, or run 'rm ~/.tokenwall/database.sqlite' to clear history).`
            };
        }
        // 2. Check Sequential Failures
        const lastThreeFailed = recentRequests.slice(0, 3).every(r => r.status === 'failed');
        if (lastThreeFailed) {
            const lastFailedReq = recentRequests[0];
            const lastFailedTime = new Date(lastFailedReq.created_at + ' UTC').getTime();
            const secondsSinceLastFailure = (Date.now() - lastFailedTime) / 1000;
            const isSimilarTokenSize = Math.abs(lastFailedReq.input_tokens - newInputTokens) <= 3;
            const isRapidRetry = secondsSinceLastFailure < 15;
            if (isSimilarTokenSize && isRapidRetry) {
                return {
                    loopDetected: true,
                    reason: 'Loop Protection: Three consecutive requests failed or resulted in errors. Halting execution to prevent automated retry loops. (Bypass: Wait 60s or change your prompt content slightly).'
                };
            }
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
                reason: 'Loop Protection: Duplicate prompt footprint detected. Multiple sequential requests have the exact same token footprint (potential infinite retry loop). (Bypass: Wait 60s for a quiet period reset, or change your prompt content slightly).'
            };
        }
        return { loopDetected: false };
    }
}
exports.RunawayLoopDetector = RunawayLoopDetector;
