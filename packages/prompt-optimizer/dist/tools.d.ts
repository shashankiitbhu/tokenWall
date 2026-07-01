export declare class ToolRouter {
    /**
     * Drops irrelevant tools if the number of tools exceeds a threshold (e.g. 15).
     * It uses lightweight keyword matching against the user's prompt.
     */
    static route(tools: any[], messages: any[]): any[];
}
export declare class ToolSchemaOptimizer {
    /**
     * Cleans up tautological zero-information descriptions
     */
    static isTautological(name: string, description: string): boolean;
    /**
     * Truncates description to first sentence, preserving constraints.
     */
    static truncateDescription(desc: string, aggressive: boolean): string;
    static optimizeSchemaNode(node: any, aggressive?: boolean): void;
    static optimize(tools: any[], aggressive?: boolean): any[];
}
export declare class ToolPayloadCrusher {
    /**
     * Detects if an array is homogeneous (objects with identical keys and primitive values)
     */
    static isHomogeneous(arr: any[]): boolean;
    static convertToCSV(arr: any[]): string;
    static crushArray(arr: any[], maxItems: number, maxTokens: number, model: string): any[];
    static optimizeToolResult(content: string, model: string): string;
}
