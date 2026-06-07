"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalUI = exports.c = void 0;
const promises_1 = __importDefault(require("readline/promises"));
const process_1 = require("process");
// ANSI terminal colors helper
exports.c = {
    reset: (text) => `\x1b[0m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    red: (text) => `\x1b[31m${text}\x1b[39m`,
    green: (text) => `\x1b[32m${text}\x1b[39m`,
    yellow: (text) => `\x1b[33m${text}\x1b[39m`,
    blue: (text) => `\x1b[34m${text}\x1b[39m`,
    magenta: (text) => `\x1b[35m${text}\x1b[39m`,
    cyan: (text) => `\x1b[36m${text}\x1b[39m`,
    gray: (text) => `\x1b[90m${text}\x1b[39m`
};
class TerminalUI {
    static drawGatewayStartup(port) {
        console.log(exports.c.cyan('┌──────────────────────────────────────────────────────────┐'));
        console.log(`${exports.c.cyan('│')}  ${exports.c.bold(exports.c.green('TOKENWALL PROXY INTERCEPTOR RUNNING'))}                     ${exports.c.cyan('│')}`);
        console.log(`${exports.c.cyan('│')}  Port: ${exports.c.bold(port.toString())}                                                ${exports.c.cyan('│')}`);
        console.log(`${exports.c.cyan('│')}  Status: Intercepting API Base URLs                        ${exports.c.cyan('│')}`);
        console.log(exports.c.cyan('└──────────────────────────────────────────────────────────┘'));
    }
    static drawSessionStatus(sessionSpend, dailySpend, dailyLimit) {
        const sessionText = `$${sessionSpend.toFixed(2)}`;
        const dailyText = `$${dailySpend.toFixed(2)} / $${dailyLimit.toFixed(2)}`;
        console.log(exports.c.gray('┌──────────────────────────────────────────────────────────┐'));
        console.log(`${exports.c.gray('│')}  Session Spend: ${exports.c.bold(exports.c.yellow(sessionText))}                                ${exports.c.gray('│')}`);
        console.log(`${exports.c.gray('│')}  Daily Budget:  ${exports.c.bold(exports.c.cyan(dailyText))}                           ${exports.c.gray('│')}`);
        console.log(exports.c.gray('└──────────────────────────────────────────────────────────┘'));
    }
    static drawPreFlightReport(data) {
        const { model, estimation, contextReport, routing, optimization } = data;
        console.log('\n' + exports.c.bold(exports.c.yellow('⚠️  PRE-FLIGHT COST ALERT')));
        console.log(exports.c.gray('─'.repeat(60)));
        console.log(`${exports.c.bold('Model:')}             ${exports.c.cyan(model)}`);
        console.log(`${exports.c.bold('Estimated Cost:')}    ${exports.c.bold(exports.c.red(`$${estimation.estimatedCost.toFixed(4)}`))} (confidence: ${Math.round(estimation.confidence * 100)}%)`);
        console.log(`${exports.c.bold('Input Tokens:')}      ${exports.c.bold(estimation.estimatedInputTokens.toLocaleString())}`);
        console.log(`${exports.c.bold('Expected Output:')}   ${exports.c.bold(estimation.estimatedOutputTokens.toLocaleString())}`);
        if (estimation.amplificationReason) {
            console.log(`${exports.c.bold('Cost Amplification:')} ${exports.c.gray(estimation.amplificationReason)}`);
        }
        // Inefficiencies
        if (contextReport.inefficiencies.length > 0) {
            console.log('\n' + exports.c.bold(exports.c.red('Context Inefficiencies Detected:')));
            for (const item of contextReport.inefficiencies) {
                console.log(`  • ${exports.c.yellow(item.description)} (${item.approximateTokens.toLocaleString()} tokens)`);
            }
            console.log(`  Potential context savings: ${exports.c.green(`~${contextReport.totalWasteTokens.toLocaleString()} tokens`)}`);
        }
        // Routing Recommendation
        if (routing.shouldRoute) {
            console.log('\n' + exports.c.bold(exports.c.green('Smart Model Routing Recommendation:')));
            console.log(`  Recommendation: ${exports.c.bold(exports.c.green(routing.recommendedModel))} (Saves ${exports.c.green(`${routing.savingsPercentage}%`)} cost)`);
            console.log(`  Reason: ${exports.c.gray(routing.explanation)}`);
        }
        // Optimization Suggestion
        if (optimization && optimization.tokensSaved > 0) {
            console.log('\n' + exports.c.bold(exports.c.cyan('Prompt Optimization Suggestions:')));
            console.log(`  Heuristics saved ${exports.c.bold(exports.c.green(optimization.savingsPercent.toString() + '%'))} prompt tokens (Saved ${optimization.tokensSaved} tokens).`);
        }
        console.log(exports.c.gray('─'.repeat(60)));
    }
    static async askApproval() {
        const rl = promises_1.default.createInterface({ input: process_1.stdin, output: process_1.stdout });
        try {
            console.log(exports.c.bold('\nChoose an action:'));
            console.log(`  [${exports.c.green('y')}] Approve request and execute`);
            console.log(`  [${exports.c.cyan('o')}] Approve with Prompt Optimization`);
            console.log(`  [${exports.c.yellow('s')}] Switch model to cheaper recommendation`);
            console.log(`  [${exports.c.red('n')}] Cancel request`);
            while (true) {
                const answer = (await rl.question(exports.c.bold('Action: '))).trim().toLowerCase();
                if (answer === 'y' || answer === 'yes' || answer === '') {
                    return 'approve';
                }
                if (answer === 'o' || answer === 'opt') {
                    return 'optimize';
                }
                if (answer === 's' || answer === 'switch') {
                    return 'switch_model';
                }
                if (answer === 'n' || answer === 'no' || answer === 'c') {
                    return 'cancel';
                }
                console.log(exports.c.red('Invalid input. Please enter y, o, s, or n.'));
            }
        }
        finally {
            rl.close();
        }
    }
    static drawBlockedAlert(reason) {
        console.log('\n' + exports.c.bold(exports.c.red('❌ REQUEST BLOCKED BY TOKENWALL BUDGET ENFORCEMENT')));
        console.log(exports.c.gray('─'.repeat(60)));
        console.log(`${exports.c.bold('Reason:')} ${exports.c.yellow(reason)}`);
        console.log(exports.c.gray('─'.repeat(60)) + '\n');
    }
}
exports.TerminalUI = TerminalUI;
