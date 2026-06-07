import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { EstimationResult } from '@tokenwall/estimators';
import { ContextReport } from '@tokenwall/context-engine';
import { RouteRecommendation } from '@tokenwall/routing-engine';
import { OptimizationResult } from '@tokenwall/prompt-optimizer';

// ANSI terminal colors helper
export const c = {
  reset: (text: string) => `\x1b[0m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  red: (text: string) => `\x1b[31m${text}\x1b[39m`,
  green: (text: string) => `\x1b[32m${text}\x1b[39m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[39m`,
  blue: (text: string) => `\x1b[34m${text}\x1b[39m`,
  magenta: (text: string) => `\x1b[35m${text}\x1b[39m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[39m`,
  gray: (text: string) => `\x1b[90m${text}\x1b[39m`
};

export class TerminalUI {
  static drawGatewayStartup(port: number) {
    console.log(c.cyan('┌──────────────────────────────────────────────────────────┐'));
    console.log(`${c.cyan('│')}  ${c.bold(c.green('TOKENWALL PROXY INTERCEPTOR RUNNING'))}                     ${c.cyan('│')}`);
    console.log(`${c.cyan('│')}  Port: ${c.bold(port.toString())}                                                ${c.cyan('│')}`);
    console.log(`${c.cyan('│')}  Status: Intercepting API Base URLs                        ${c.cyan('│')}`);
    console.log(c.cyan('└──────────────────────────────────────────────────────────┘'));
  }

  static drawSessionStatus(sessionSpend: number, dailySpend: number, dailyLimit: number) {
    const sessionText = `$${sessionSpend.toFixed(2)}`;
    const dailyText = `$${dailySpend.toFixed(2)} / $${dailyLimit.toFixed(2)}`;
    console.log(c.gray('┌──────────────────────────────────────────────────────────┐'));
    console.log(`${c.gray('│')}  Session Spend: ${c.bold(c.yellow(sessionText))}                                ${c.gray('│')}`);
    console.log(`${c.gray('│')}  Daily Budget:  ${c.bold(c.cyan(dailyText))}                           ${c.gray('│')}`);
    console.log(c.gray('└──────────────────────────────────────────────────────────┘'));
  }

  static drawPreFlightReport(data: {
    model: string;
    estimation: EstimationResult;
    contextReport: ContextReport;
    routing: RouteRecommendation;
    optimization?: OptimizationResult;
  }) {
    const { model, estimation, contextReport, routing, optimization } = data;

    console.log('\n' + c.bold(c.yellow('⚠️  PRE-FLIGHT COST ALERT')));
    console.log(c.gray('─'.repeat(60)));
    console.log(`${c.bold('Model:')}             ${c.cyan(model)}`);
    console.log(`${c.bold('Estimated Cost:')}    ${c.bold(c.red(`$${estimation.estimatedCost.toFixed(4)}`))} (confidence: ${Math.round(estimation.confidence * 100)}%)`);
    console.log(`${c.bold('Input Tokens:')}      ${c.bold(estimation.estimatedInputTokens.toLocaleString())}`);
    console.log(`${c.bold('Expected Output:')}   ${c.bold(estimation.estimatedOutputTokens.toLocaleString())}`);
    
    if (estimation.amplificationReason) {
      console.log(`${c.bold('Cost Amplification:')} ${c.gray(estimation.amplificationReason)}`);
    }

    // Inefficiencies
    if (contextReport.inefficiencies.length > 0) {
      console.log('\n' + c.bold(c.red('Context Inefficiencies Detected:')));
      for (const item of contextReport.inefficiencies) {
        console.log(`  • ${c.yellow(item.description)} (${item.approximateTokens.toLocaleString()} tokens)`);
      }
      console.log(`  Potential context savings: ${c.green(`~${contextReport.totalWasteTokens.toLocaleString()} tokens`)}`);
    }

    // Routing Recommendation
    if (routing.shouldRoute) {
      console.log('\n' + c.bold(c.green('Smart Model Routing Recommendation:')));
      console.log(`  Recommendation: ${c.bold(c.green(routing.recommendedModel))} (Saves ${c.green(`${routing.savingsPercentage}%`)} cost)`);
      console.log(`  Reason: ${c.gray(routing.explanation)}`);
    }

    // Optimization Suggestion
    if (optimization && optimization.tokensSaved > 0) {
      console.log('\n' + c.bold(c.cyan('Prompt Optimization Suggestions:')));
      console.log(`  Heuristics saved ${c.bold(c.green(optimization.savingsPercent.toString() + '%'))} prompt tokens (Saved ${optimization.tokensSaved} tokens).`);
    }
    console.log(c.gray('─'.repeat(60)));
  }

  static async askApproval(costStr: string, model: string): Promise<'approve' | 'optimize' | 'switch_model' | 'cancel'> {
    // We use osascript to show an out-of-band native dialog so we don't pollute the terminal's stdin/stdout
    const execSync = require('child_process').execSync;
    const prompt = `TokenWall Budget Warning: Estimated cost is $${costStr} for ${model}. How would you like to proceed?`;
    
    const script = `
      set dialogResult to display dialog "${prompt}" buttons {"Cancel", "Switch Model", "Optimize", "Approve"} default button "Approve" with title "TokenWall Pre-Flight Check" with icon caution
      return button returned of dialogResult
    `;
    
    try {
      const result = execSync(`osascript -e '${script}'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (result === 'Approve') return 'approve';
      if (result === 'Optimize') return 'optimize';
      if (result === 'Switch Model') return 'switch_model';
      return 'cancel';
    } catch (e) {
      // If the user clicks cancel, osascript exits with non-zero code
      return 'cancel';
    }
  }

  static drawBlockedAlert(reason: string) {
    console.log('\n' + c.bold(c.red('❌ REQUEST BLOCKED BY TOKENWALL BUDGET ENFORCEMENT')));
    console.log(c.gray('─'.repeat(60)));
    console.log(`${c.bold('Reason:')} ${c.yellow(reason)}`);
    console.log(c.gray('─'.repeat(60)) + '\n');
  }
}
