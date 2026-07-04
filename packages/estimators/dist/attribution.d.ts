import { NormalizedRequest } from '@tokenwall/providers';
export interface TokenAttribution {
    sourceCodeTokens: number;
    logsTokens: number;
    toolSchemasTokens: number;
    jsonPayloadsTokens: number;
    systemPromptTokens: number;
    conversationTokens: number;
    totalTokens: number;
}
export declare class TokenAttributionAnalyzer {
    static analyze(req: NormalizedRequest): TokenAttribution;
}
