export interface Message {
    role: string;
    content: string;
}
export interface NormalizedRequest {
    provider: 'openai' | 'anthropic' | 'gemini';
    model: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
    stream: boolean;
    toolsAttached: boolean;
    rawBody: any;
    systemInstruction?: string;
    toolsSchemaText?: string;
}
export interface NormalizedResponse {
    id: string;
    model: string;
    content: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}
export declare class ProviderRegistry {
    static parseRequest(provider: 'openai' | 'anthropic' | 'gemini', body: any, urlPath?: string): NormalizedRequest;
    static parseResponse(provider: 'openai' | 'anthropic' | 'gemini', body: any): NormalizedResponse;
    static parseStreamChunk(provider: 'openai' | 'anthropic' | 'gemini', chunkText: string): {
        text: string;
        usage?: {
            inputTokens: number;
            outputTokens: number;
            cacheCreationTokens?: number;
            cacheReadTokens?: number;
        };
    } | null;
}
