export interface CacheAlignmentContext {
    prompt: string;
    role: string;
    isSystem: boolean;
    findings: any[];
    cacheabilityScore: number;
}
export interface CacheAlignerPlugin {
    name: string;
    apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext;
}
export declare class WhitespaceNormalizationPlugin implements CacheAlignerPlugin {
    name: string;
    apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext;
}
export declare class DeterministicJsonPlugin implements CacheAlignerPlugin {
    name: string;
    apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext;
}
export declare class ToolSchemaSortPlugin implements CacheAlignerPlugin {
    name: string;
    apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext;
    static sortTools(tools: any[]): any[];
}
export declare class VolatileRelocationPlugin implements CacheAlignerPlugin {
    name: string;
    apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext;
}
export declare class PromptFingerprintPlugin implements CacheAlignerPlugin {
    name: string;
    apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext;
}
export declare class CacheAlignerPipeline {
    private plugins;
    constructor();
    align(prompt: string, role: string, isSystem: boolean, options?: any): CacheAlignmentContext;
}
