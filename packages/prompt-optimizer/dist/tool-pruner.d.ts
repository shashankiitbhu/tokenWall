export declare class ToolPruner {
    /**
     * Prunes obviously irrelevant tools from the request payload based on safe heuristics.
     * Modifies the requestBody in-place and returns the number of tokens saved.
     */
    static pruneTools(provider: 'openai' | 'anthropic' | 'gemini', requestBody: any, model: string, conversationContext: string): number;
}
