import { EstimationResult } from '@tokenwall/estimators';
import { ContextReport } from '@tokenwall/context-engine';
import { RouteRecommendation } from '@tokenwall/routing-engine';
import { OptimizationResult } from '@tokenwall/prompt-optimizer';
export declare const c: {
    reset: (text: string) => string;
    bold: (text: string) => string;
    red: (text: string) => string;
    green: (text: string) => string;
    yellow: (text: string) => string;
    blue: (text: string) => string;
    magenta: (text: string) => string;
    cyan: (text: string) => string;
    gray: (text: string) => string;
};
export declare class TerminalUI {
    static drawGatewayStartup(port: number): void;
    static drawSessionStatus(sessionSpend: number, dailySpend: number, dailyLimit: number): void;
    static drawPreFlightReport(data: {
        model: string;
        estimation: EstimationResult;
        contextReport: ContextReport;
        routing: RouteRecommendation;
        optimization?: OptimizationResult;
    }): void;
    static askApproval(costStr: string, model: string): Promise<'approve' | 'optimize' | 'switch_model' | 'cancel'>;
    static drawBlockedAlert(reason: string): void;
}
