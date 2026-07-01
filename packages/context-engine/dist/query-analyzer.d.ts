export declare class QueryAnalyzer {
    /**
     * Extracts high-signal lexical keywords from a query string.
     */
    static extractKeywords(text: string): string[];
    /**
     * Extracts keywords from the last 'user' message in the array.
     */
    static extractFromMessages(messages: any[]): string[];
}
