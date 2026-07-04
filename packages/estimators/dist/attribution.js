"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenAttributionAnalyzer = void 0;
const index_1 = require("./index");
class TokenAttributionAnalyzer {
    static analyze(req) {
        let sourceCodeTokens = 0;
        let logsTokens = 0;
        let toolSchemasTokens = 0;
        let jsonPayloadsTokens = 0;
        let systemPromptTokens = 0;
        let conversationTokens = 0;
        // 1. Tool Schemas
        if (req.toolsSchemaText) {
            toolSchemasTokens += (0, index_1.countTokens)(req.toolsSchemaText, req.model);
        }
        // 2. Messages
        for (const msg of req.messages) {
            if (msg.role === 'system') {
                systemPromptTokens += (0, index_1.countTokens)(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content), req.model);
                continue;
            }
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            let remainingContent = content;
            const extract = (regex, categoryFn) => {
                remainingContent = remainingContent.replace(regex, (fullMatch, group1) => {
                    categoryFn(fullMatch, group1);
                    return '';
                });
            };
            // A. Extract JSON blocks
            extract(/```(?:json|jsonl)\s+([\s\S]*?)\s*```/gi, (match) => {
                jsonPayloadsTokens += (0, index_1.countTokens)(match, req.model);
            });
            // B. Extract XML File blocks (<file_content>)
            extract(/<file_content path="([^"]+)">\n?([\s\S]*?)\n?<\/file_content>/gi, (match, path) => {
                const filePath = (path || '').toLowerCase();
                const tokens = (0, index_1.countTokens)(match, req.model);
                if (filePath.endsWith('.log'))
                    logsTokens += tokens;
                else if (filePath.endsWith('.json') || filePath.includes('lock'))
                    jsonPayloadsTokens += tokens;
                else
                    sourceCodeTokens += tokens;
            });
            // C. Extract Markdown File blocks (File: foo.ts)
            extract(/(?:File|Path|Filename):\s*([/\\]?[^\s"']+)\n([\s\S]*?)(?=\n(?:File|Path|Filename):|$)/gi, (match, path) => {
                const filePath = (path || '').toLowerCase();
                const tokens = (0, index_1.countTokens)(match, req.model);
                if (filePath.endsWith('.log'))
                    logsTokens += tokens;
                else if (filePath.endsWith('.json') || filePath.includes('lock'))
                    jsonPayloadsTokens += tokens;
                else
                    sourceCodeTokens += tokens;
            });
            // D. Extract remaining Code blocks (Markdown)
            extract(/```(?:javascript|typescript|js|ts|python|py|rust|rs|go|golang|cpp|c\+\+|java|c|shell|sh|bash)\s+([\s\S]*?)\s*```/gi, (match) => {
                sourceCodeTokens += (0, index_1.countTokens)(match, req.model);
            });
            // E. Extract Logs (Stack traces or Error dumps)
            extract(/(?:.*?(?:Error|Exception|Failed).*?\n)?(?:(?:\s+at\s+.*?\n)+)/gi, (match) => {
                logsTokens += (0, index_1.countTokens)(match, req.model);
            });
            // F. Conversation is what's left
            if (remainingContent.trim().length > 0) {
                conversationTokens += (0, index_1.countTokens)(remainingContent, req.model);
            }
        }
        const totalTokens = sourceCodeTokens + logsTokens + toolSchemasTokens + jsonPayloadsTokens + systemPromptTokens + conversationTokens;
        return {
            sourceCodeTokens,
            logsTokens,
            toolSchemasTokens,
            jsonPayloadsTokens,
            systemPromptTokens,
            conversationTokens,
            totalTokens
        };
    }
}
exports.TokenAttributionAnalyzer = TokenAttributionAnalyzer;
