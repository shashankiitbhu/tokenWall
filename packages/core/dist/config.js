"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const DEFAULT_CONFIG = {
    dailyLimit: 10.0,
    monthlyLimit: 100.0,
    sessionLimit: 2.0,
    hardLimitsEnabled: true,
    blacklistedPatterns: [
        '**/node_modules/**',
        '**/.git/**',
        '**/package-lock.json',
        '**/yarn.lock',
        '**/pnpm-lock.yaml',
        '**/*.log',
        '**/*.min.js',
        '**/*.min.css',
        '**/*.mp4',
        '**/*.png',
        '**/*.jpg'
    ],
    autoOptimize: true,
    headless: false,
    autoApproveLimit: 0.10,
    autoDenyLimit: 5.00,
    routingPolicy: {
        autoSwitchBelowThreshold: 0.10,
        neverDowngradeReasoning: true,
        budgetAwareRouting: false
    }
};
class ConfigManager {
    configPath;
    config;
    constructor(configPath) {
        this.configPath = configPath || path_1.default.join(os_1.default.homedir(), '.tokenwall', 'config.json');
        this.config = this.loadConfig();
    }
    loadConfig() {
        try {
            if (fs_1.default.existsSync(this.configPath)) {
                const raw = fs_1.default.readFileSync(this.configPath, 'utf8');
                return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
            }
        }
        catch (e) {
            console.warn('⚠️ Could not load config, using default settings.', e);
        }
        this.saveConfig(DEFAULT_CONFIG);
        return DEFAULT_CONFIG;
    }
    saveConfig(newConfig) {
        try {
            const dir = path_1.default.dirname(this.configPath);
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
            fs_1.default.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 2), 'utf8');
            this.config = newConfig;
        }
        catch (e) {
            console.error('⚠️ Could not save configuration file:', e);
        }
    }
    getConfig() {
        return this.config;
    }
}
exports.ConfigManager = ConfigManager;
