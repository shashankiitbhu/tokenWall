import fs from 'fs';
import path from 'path';
import os from 'os';

export interface TokenWallConfig {
  dailyLimit: number;
  monthlyLimit: number;
  sessionLimit: number;
  hardLimitsEnabled: boolean;
  blacklistedPatterns: string[];
  autoOptimize: boolean;
  modelPricingOverrides?: Record<string, { inputPrice: number; outputPrice: number }>;
}

const DEFAULT_CONFIG: TokenWallConfig = {
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
  autoOptimize: true
};

export class ConfigManager {
  private configPath: string;
  private config: TokenWallConfig;

  constructor(configPath?: string) {
    this.configPath = configPath || path.join(os.homedir(), '.tokenwall', 'config.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): TokenWallConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      }
    } catch (e) {
      console.warn('⚠️ Could not load config, using default settings.', e);
    }
    this.saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  saveConfig(newConfig: TokenWallConfig) {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 2), 'utf8');
      this.config = newConfig;
    } catch (e) {
      console.error('⚠️ Could not save configuration file:', e);
    }
  }

  getConfig(): TokenWallConfig {
    return this.config;
  }
}
