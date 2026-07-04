export interface MitigationContext {
    currentTurnText: string;
    fileShadowState: Map<string, {
        content: string;
        hops: number;
    }>;
    model: string;
}
export declare class LostInMiddleMitigator {
    private static mdRegex;
    private static xmlRegex;
    private static diagnosticRegex;
    static reorder(content: string, context: MitigationContext): string;
    private static scoreBlock;
}
