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
}
export declare class ConfigManager {
    private configPath;
    private config;
    constructor(configPath?: string);
    private loadConfig;
    saveConfig(newConfig: TokenWallConfig): void;
    getConfig(): TokenWallConfig;
}
