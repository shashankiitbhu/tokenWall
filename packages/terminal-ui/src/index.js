"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalUI = exports.c = void 0;
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
        if (routing.shouldRoute && routing.alternatives.length > 0) {
            console.log('\n' + exports.c.bold(exports.c.green('Smart Model Routing Recommendation:')));
            const bestAlternative = routing.alternatives[0];
            console.log(`  Recommendation: ${exports.c.bold(exports.c.green(bestAlternative.model))} (Saves ${exports.c.green(`${bestAlternative.savingsPercentage}%`)} cost)`);
            console.log(`  Reason: ${exports.c.gray(routing.explanation)}`);
        }
        // Optimization Suggestion
        if (optimization && optimization.tokensSaved > 0) {
            console.log('\n' + exports.c.bold(exports.c.cyan('Prompt Optimization Suggestions:')));
            console.log(`  Heuristics saved ${exports.c.bold(exports.c.green(optimization.savingsPercent.toString() + '%'))} prompt tokens (Saved ${optimization.tokensSaved} tokens).`);
        }
        console.log(exports.c.gray('─'.repeat(60)));
    }
    static async askApproval(costStr, model) {
        // We use osascript to show an out-of-band native dialog so we don't pollute the terminal's stdin/stdout
        const execSync = require('child_process').execSync;
        const prompt = `TokenWall Budget Warning: Estimated cost is $${costStr} for ${model}. How would you like to proceed?`;
        const script = `
      set dialogResult to display dialog "${prompt}" buttons {"Cancel", "Switch Model", "Optimize", "Approve"} default button "Approve" with title "TokenWall Pre-Flight Check" with icon caution
      return button returned of dialogResult
    `;
        try {
            const result = execSync(`osascript -e '${script}'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            if (result === 'Approve')
                return 'approve';
            if (result === 'Optimize')
                return 'optimize';
            if (result === 'Switch Model')
                return 'switch_model';
            return 'cancel';
        }
        catch (e) {
            // If the user clicks cancel, osascript exits with non-zero code
            return 'cancel';
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
