export interface TokenWallConfig {
    dailyLimit: number;
    monthlyLimit: number;
    sessionLimit: number;
    hardLimitsEnabled: boolean;
    blacklistedPatterns: string[];
    autoOptimize: boolean;
    modelPricingOverrides?: Record<string, {
        inputPrice: number;
        outputPrice: number;
    }>;
    headless?: boolean;
    autoApproveLimit?: number;
    autoDenyLimit?: number;
    routingPolicy?: {
        autoSwitchBelowThreshold?: number;
        neverDowngradeReasoning?: boolean;
        budgetAwareRouting?: boolean;
    };
    reversibleCompression?: boolean;
    verbositySteering?: boolean;
    jsonCrushing?: boolean;
    codeCompression?: boolean;
    cacheAlignment?: boolean;
    enablePayloadLogging?: boolean;
    importance?: {
        policy: 'conservative' | 'balanced' | 'aggressive';
    };
}
export declare class ConfigManager {
    private configPath;
    private config;
    constructor(configPath?: string);
    private loadConfig;
    saveConfig(newConfig: TokenWallConfig): void;
    getConfig(): TokenWallConfig;
}
