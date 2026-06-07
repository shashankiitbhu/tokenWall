#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const core_1 = require("@tokenwall/core");
const path_1 = __importDefault(require("path"));
const args = process.argv.slice(2);
const command = args[0];
const db = new core_1.DBManager();
const configManager = new core_1.ConfigManager();
function showHelp() {
    console.log(`
${cBold(cGreen('TokenWall'))} - AI Spend Prevention & Budget Governance Platform

${cBold('Usage:')}
  tokenwall start [--headless]    Start the standalone interception gateway
  tokenwall approve               Connect to control plane to approve requests
  tokenwall exec -- <command>     Run an agent command wrapped with budget interception
  tokenwall exec -- <command>     Run an agent command wrapped with budget interception
  tokenwall status                Show current budget usage and statistics
  tokenwall config <key>=<value>  Update local configuration limits

${cBold('Examples:')}
  tokenwall exec -- npx @anthropic-ai/claude-code
  tokenwall config dailyLimit=5.0
  tokenwall config hardLimitsEnabled=true
  `);
}
function cBold(text) { return `\x1b[1m${text}\x1b[22m`; }
function cGreen(text) { return `\x1b[32m${text}\x1b[39m`; }
function cYellow(text) { return `\x1b[33m${text}\x1b[39m`; }
function cBlue(text) { return `\x1b[34m${text}\x1b[39m`; }
function cCyan(text) { return `\x1b[36m${text}\x1b[39m`; }
function cRed(text) { return `\x1b[31m${text}\x1b[39m`; }
function cGray(text) { return `\x1b[90m${text}\x1b[39m`; }
async function main() {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
        showHelp();
        return;
    }
    if (command === 'start') {
        const isHeadless = args.includes('--headless');
        console.log(cBold(cCyan('Starting TokenWall gateway...')));
        // Launch gateway server in-process by executing the gateway file
        const gatewayPath = path_1.default.resolve(__dirname, '../../gateway/dist/index.js');
        const gatewayProc = (0, child_process_1.spawn)('node', [gatewayPath], {
            stdio: 'inherit',
            env: { ...process.env, TOKENWALL_HEADLESS: isHeadless ? 'true' : 'false' }
        });
        gatewayProc.on('exit', (code) => {
            process.exit(code || 0);
        });
        return;
    }
    if (command === 'approve') {
        console.log(cBold(cBlue('🔗 Connecting to TokenWall Control Plane...')));
        const WebSocket = require('ws');
        const ws = new WebSocket('ws://127.0.0.1:1984/ws/control');
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        ws.on('open', () => {
            console.log(cGreen('✔ Connected. Waiting for approval requests...\n'));
        });
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'approval_pending') {
                    const req = msg.payload;
                    console.log(cBold(cYellow(`\n⚠️  APPROVAL REQUIRED [${req.requestId}]`)));
                    console.log(`Model: ${req.model}`);
                    console.log(`Estimated Cost: $${req.estimatedCost.toFixed(4)}`);
                    if (req.warnings && req.warnings.length > 0) {
                        console.log(cRed(`Warnings:\n - ${req.warnings.join('\n - ')}`));
                    }
                    rl.question(cBold('Action (y: Approve, n: Deny, o: Optimize): '), (answer) => {
                        const ans = answer.trim().toLowerCase();
                        let action = 'cancel';
                        if (ans === 'y' || ans === 'yes')
                            action = 'approve';
                        if (ans === 'o')
                            action = 'optimize';
                        ws.send(JSON.stringify({
                            type: 'approval_resolved',
                            payload: { requestId: req.requestId, action }
                        }));
                        console.log(cGreen(`✔ Action '${action}' sent.\n`));
                    });
                }
                else if (msg.type === 'approval_cleared') {
                    console.log(cGray(`\nℹ️ Request ${msg.payload.requestId} was handled by another client or timed out.`));
                }
            }
            catch (e) {
                // ignore
            }
        });
        ws.on('close', () => {
            console.log(cRed('❌ Connection closed.'));
            rl.close();
            process.exit(1);
        });
        ws.on('error', (err) => {
            console.error(cRed('❌ WebSocket error:'), err.message);
            rl.close();
            process.exit(1);
        });
        return;
    }
    if (command === 'exec') {
        const doubleDashIdx = args.indexOf('--');
        if (doubleDashIdx === -1 || doubleDashIdx === args.length - 1) {
            console.error(cRed('Error: Please specify the command to run after "--".'));
            console.log('Example: tokenwall exec -- claude-code');
            return;
        }
        const agentCmd = args.slice(doubleDashIdx + 1);
        const cmdName = agentCmd[0];
        const cmdArgs = agentCmd.slice(1);
        console.log(cBold(cGreen('Initializing TokenWall Interception Wrapper...')));
        // 1. Spin up the gateway server locally in the background
        const isHeadless = args.includes('--headless');
        const gatewayPath = path_1.default.resolve(__dirname, '../../gateway/dist/index.js');
        const gatewayServer = (0, child_process_1.spawn)('node', [gatewayPath], {
            stdio: 'ignore', // Do not inherit stdio, prevent TTY collisions
            env: { ...process.env, PORT: '1984', TOKENWALL_HEADLESS: isHeadless ? 'true' : 'false' }
        });
        // Wait a brief moment for the gateway to boot on port 1984
        await new Promise((resolve) => setTimeout(resolve, 1500));
        // 2. Set environment variables to point to the local gateway
        const sessionUuid = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        const currentDir = process.cwd();
        const project = db.getOrCreateProject(path_1.default.basename(currentDir), currentDir);
        const env = {
            ...process.env,
            OPENAI_BASE_URL: 'http://localhost:1984/v1',
            ANTHROPIC_BASE_URL: 'http://localhost:1984',
            GEMINI_BASE_URL: 'http://localhost:1984',
            TOKENWALL_SESSION_ID: sessionUuid,
            TOKENWALL_PROJECT_ID: project.id
        };
        console.log(cBold(cGreen(`Running Agent: "${cmdName} ${cmdArgs.join(' ')}"`)));
        console.log(cGray(`Session ID: ${sessionUuid}`));
        console.log(cGray(`Project:    ${project.name} (${project.id})`));
        console.log(cGray('─'.repeat(50)));
        // 3. Spawn the child agent process
        const agentProcess = (0, child_process_1.spawn)(cmdName, cmdArgs, { stdio: 'inherit', env });
        agentProcess.on('exit', (code) => {
            console.log('\n' + cBold(cGreen('─'.repeat(50))));
            console.log(cBold(cGreen('Agent session completed.')));
            // Query and display session summary
            const summary = db.getSessionSummary(sessionUuid);
            console.log(`  Total Cost:         ${cBold(cYellow(`$${summary.totalCost.toFixed(4)}`))}`);
            console.log(`  Requests Intercepted: ${summary.count}`);
            console.log(`  Tokens Saved:       ${cGreen(summary.saved.toLocaleString())}`);
            console.log(cBold(cGreen('─'.repeat(50))));
            // Kill the local gateway server
            gatewayServer.kill();
            process.exit(code || 0);
        });
        return;
    }
    if (command === 'status') {
        const config = configManager.getConfig();
        console.log(cBold(cCyan('=== TOKENWALL STATUS ===')));
        console.log(`Daily Limit:        $${config.dailyLimit.toFixed(2)}`);
        console.log(`Monthly Limit:      $${config.monthlyLimit.toFixed(2)}`);
        console.log(`Session Limit:      $${config.sessionLimit.toFixed(2)}`);
        console.log(`Hard Limits:        ${config.hardLimitsEnabled ? cGreen('Enabled') : cYellow('Disabled (Warn Only)')}`);
        console.log(`Auto Optimization:  ${config.autoOptimize ? cGreen('Enabled') : cYellow('Disabled')}`);
        // Display global/project spend summaries
        const budgets = db.getBudgets(null);
        if (budgets.length > 0) {
            console.log('\n' + cBold('Current Spend Metrics:'));
            for (const b of budgets) {
                const percent = Math.min(100, Math.round((b.current_spend / b.limit_amount) * 100));
                console.log(`  • ${b.period.toUpperCase()}: $${b.current_spend.toFixed(2)} / $${b.limit_amount.toFixed(2)} (${percent}%)`);
            }
        }
        return;
    }
    if (command === 'config') {
        const param = args[1];
        if (!param || !param.includes('=')) {
            console.error(cRed('Error: Please provide a configuration setting in key=value format.'));
            console.log('Example: tokenwall config dailyLimit=5.0');
            return;
        }
        const [key, rawVal] = param.split('=');
        const currentConfig = configManager.getConfig();
        if (!(key in currentConfig)) {
            console.error(cRed(`Error: Unknown configuration key "${key}".`));
            return;
        }
        let val = rawVal;
        if (rawVal === 'true')
            val = true;
        else if (rawVal === 'false')
            val = false;
        else if (!isNaN(Number(rawVal)))
            val = Number(rawVal);
        const updated = { ...currentConfig, [key]: val };
        configManager.saveConfig(updated);
        // Also update budgets in DB
        if (key === 'dailyLimit' || key === 'monthlyLimit' || key === 'sessionLimit') {
            const period = key === 'dailyLimit' ? 'daily' : key === 'monthlyLimit' ? 'monthly' : 'session';
            db.db.prepare('UPDATE budgets SET limit_amount = ? WHERE period = ? AND project_id IS NULL').run(val, period);
        }
        console.log(cGreen(`✔ Successfully updated configuration: ${key} = ${val}`));
        return;
    }
    showHelp();
}
main().catch(console.error);
