"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const ws_1 = __importDefault(require("ws"));
let daemonProcess = null;
let wsClient = null;
let statusBarItem = null;
let reconnectTimer = null;
let pollTimer = null;
let isConnected = false;
function activate(context) {
    console.log('TokenWall VS Code companion extension is now active.');
    // 1. Initialize Status Bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'tokenwall.showStatus';
    context.subscriptions.push(statusBarItem);
    updateStatusBarText('Initializing...', 'yellow');
    statusBarItem.show();
    // 2. Setup environment interception
    updateTerminalEnvironment(context).catch(console.error);
    // 3. Start Daemon Manager & Control Plane Listener
    startDaemonManager(context);
    connectControlPlane(context);
    // 4. Register commands
    context.subscriptions.push(vscode.commands.registerCommand('tokenwall.showStatus', async () => {
        await showStatusSummary();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('tokenwall.restartDaemon', () => {
        restartDaemon(context);
    }));
    // 5. Watch settings configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tokenwall')) {
            updateTerminalEnvironment(context).catch(console.error);
            syncSettingsToConfigFile();
        }
    }));
    // Perform initial config sync
    syncSettingsToConfigFile();
    // Auto-detect and configure other popular AI extensions
    autoConfigureAIExtensions().catch(console.error);
}
function deactivate() {
    stopDaemon();
    if (reconnectTimer)
        clearTimeout(reconnectTimer);
    if (pollTimer)
        clearInterval(pollTimer);
}
// -------------------------------------------------------------
// Terminal Environment Injection
// -------------------------------------------------------------
async function getOrCreateWorkspaceProject() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0)
        return null;
    const folder = folders[0];
    const name = folder.name;
    const dirPath = folder.uri.fsPath;
    try {
        const res = await fetch('http://localhost:1984/api/admin/project/get-or-create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, path: dirPath })
        });
        if (res.ok) {
            const proj = await res.json();
            return proj.id;
        }
    }
    catch (e) {
        console.error('Failed to register project folder with gateway', e);
    }
    return null;
}
async function updateTerminalEnvironment(context) {
    const env = context.environmentVariableCollection;
    const config = vscode.workspace.getConfiguration('tokenwall');
    const enableInterception = config.get('enableAutoInterception', true);
    if (enableInterception) {
        env.replace('ANTHROPIC_BASE_URL', 'http://localhost:1984');
        env.replace('OPENAI_BASE_URL', 'http://localhost:1984/v1');
        env.replace('GEMINI_BASE_URL', 'http://localhost:1984');
        // Auto-detect project id from active workspace folder
        try {
            const projectId = await getOrCreateWorkspaceProject();
            if (projectId) {
                env.replace('TOKENWALL_PROJECT_ID', projectId);
            }
        }
        catch { }
    }
    else {
        env.clear();
    }
}
// -------------------------------------------------------------
// Local Daemon Manager
// -------------------------------------------------------------
function startDaemonManager(context) {
    checkDaemonHealth().then((alive) => {
        if (!alive) {
            launchDaemon(context);
        }
    });
    // Start polling gateway stats
    pollTimer = setInterval(() => {
        fetchStatsAndUpdateUI();
    }, 10000);
}
async function checkDaemonHealth() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);
        const res = await fetch('http://localhost:1984/api/admin/budgets', { signal: controller.signal });
        clearTimeout(timeoutId);
        return res.ok;
    }
    catch {
        return false;
    }
}
function launchDaemon(context) {
    if (daemonProcess)
        return;
    const localGateway = path.resolve(context.extensionPath, '../gateway/dist/index.js');
    let gatewayPath = '';
    if (fs.existsSync(localGateway)) {
        gatewayPath = localGateway;
    }
    else {
        // node_modules resolution
        const nodeModulesPath = path.resolve(context.extensionPath, 'node_modules/@tokenwall/gateway/dist/index.js');
        if (fs.existsSync(nodeModulesPath)) {
            gatewayPath = nodeModulesPath;
        }
    }
    console.log(`Starting TokenWall gateway daemon... Resolved path: ${gatewayPath}`);
    if (gatewayPath) {
        daemonProcess = (0, child_process_1.spawn)('node', [gatewayPath], {
            stdio: 'ignore',
            env: { ...process.env, PORT: '1984', TOKENWALL_HEADLESS: 'false' }
        });
    }
    else {
        // Fallback: spawn npx global launch
        daemonProcess = (0, child_process_1.spawn)('npx', ['tokenwall', 'start'], {
            stdio: 'ignore',
            shell: true,
            env: { ...process.env, PORT: '1984', TOKENWALL_HEADLESS: 'false' }
        });
    }
    daemonProcess.on('exit', (code) => {
        console.log(`TokenWall gateway daemon exited with code ${code}`);
        daemonProcess = null;
        updateStatusBarText('Offline', 'red');
        // Auto-recovery
        setTimeout(() => {
            checkDaemonHealth().then((alive) => {
                if (!alive)
                    launchDaemon(context);
            });
        }, 5000);
    });
}
function restartDaemon(context) {
    stopDaemon();
    vscode.window.showInformationMessage('Restarting TokenWall gateway daemon...');
    setTimeout(() => launchDaemon(context), 1500);
}
function stopDaemon() {
    if (daemonProcess) {
        daemonProcess.kill();
        daemonProcess = null;
    }
}
// -------------------------------------------------------------
// WebSocket Control Plane IPC Client
// -------------------------------------------------------------
function connectControlPlane(context) {
    if (wsClient) {
        try {
            wsClient.close();
        }
        catch { }
    }
    wsClient = new ws_1.default('ws://localhost:1984/ws/control');
    wsClient.on('open', () => {
        isConnected = true;
        console.log('WS Connection to TokenWall Control Plane established.');
        fetchStatsAndUpdateUI();
    });
    wsClient.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'approval_pending') {
                await handlePendingApproval(msg.payload);
            }
            else if (msg.type === 'notification') {
                const { message, style } = msg.payload;
                if (style === 'error') {
                    vscode.window.showErrorMessage(message);
                }
                else if (style === 'warning') {
                    vscode.window.showWarningMessage(message);
                }
                else {
                    vscode.window.showInformationMessage(message);
                }
            }
        }
        catch (e) {
            console.error('Failed to parse websocket message', e);
        }
    });
    wsClient.on('close', () => {
        isConnected = false;
        updateStatusBarText('Reconnecting...', 'yellow');
        // Retry connection after 3 seconds
        if (reconnectTimer)
            clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            connectControlPlane(context);
        }, 3000);
    });
    wsClient.on('error', () => {
        isConnected = false;
    });
}
async function handlePendingApproval(req) {
    const costText = `$${req.estimatedCost.toFixed(4)}`;
    const warningsList = req.warnings.length > 0
        ? `\n\nWarnings:\n - ${req.warnings.join('\n - ')}`
        : '';
    const alternativesAvailable = req.routingAlternatives && req.routingAlternatives.length > 0;
    const buttons = ['Approve'];
    if (req.warnings.length > 0) {
        buttons.push('Optimize Prompt');
    }
    if (alternativesAvailable) {
        buttons.push('Switch Model');
    }
    buttons.push('Cancel');
    const selection = await vscode.window.showWarningMessage(`TokenWall Spend Intercept [${req.requestId}]\n` +
        `Model: ${req.model}\n` +
        `Estimated Cost: ${costText}` +
        warningsList, { modal: true }, ...buttons);
    let action = 'cancel';
    let chosenModel = undefined;
    if (selection === 'Approve') {
        action = 'approve';
    }
    else if (selection === 'Optimize Prompt') {
        action = 'optimize';
    }
    else if (selection === 'Switch Model' && req.routingAlternatives) {
        const quickPickItems = req.routingAlternatives.map((alt) => ({
            label: alt.model,
            description: `Cost: $${alt.estimatedCost.toFixed(4)} | Savings: ${alt.savingsPercentage}%`,
            detail: `Quality Level: ${alt.qualityLevel}`,
            modelName: alt.model
        }));
        const picked = await vscode.window.showQuickPick(quickPickItems, {
            title: 'Select Cost-Efficient Model Alternative',
            placeHolder: `Switch from ${req.model}`
        });
        if (picked) {
            action = 'switch_model';
            chosenModel = picked.modelName;
        }
        else {
            action = 'cancel';
        }
    }
    // Send resolution back to gateway control plane
    if (wsClient && wsClient.readyState === ws_1.default.OPEN) {
        wsClient.send(JSON.stringify({
            type: 'approval_resolved',
            payload: {
                requestId: req.requestId,
                action,
                chosenModel
            }
        }));
    }
}
// -------------------------------------------------------------
// Live Observability Status Bar & Stats Fetch
// -------------------------------------------------------------
async function fetchStatsAndUpdateUI() {
    if (!isConnected)
        return;
    try {
        const res = await fetch('http://localhost:1984/api/admin/summary');
        if (res.ok) {
            const summary = await res.json();
            const totalSaved = summary.preventedSpend + summary.optimizedSavings;
            const text = `Today: $${summary.dailySpend.toFixed(2)} • Saved: $${totalSaved.toFixed(2)}`;
            const warningPercent = summary.dailySpend / (summary.dailyLimit || 10.0);
            let color = 'green';
            if (warningPercent >= 0.9) {
                color = 'red';
            }
            else if (warningPercent >= 0.7) {
                color = 'yellow';
            }
            updateStatusBarText(text, color);
        }
    }
    catch {
        updateStatusBarText('Offline', 'red');
    }
}
function updateStatusBarText(text, color) {
    if (!statusBarItem)
        return;
    statusBarItem.text = `$(shield) ${text}`;
    if (color === 'red') {
        statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
    }
    else if (color === 'yellow') {
        statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    }
    else {
        statusBarItem.color = undefined;
    }
}
async function showStatusSummary() {
    try {
        const res = await fetch('http://localhost:1984/api/admin/summary');
        if (!res.ok) {
            vscode.window.showErrorMessage('TokenWall Gateway daemon API is unreachable.');
            return;
        }
        const summary = await res.json();
        const totalSaved = summary.preventedSpend + summary.optimizedSavings;
        const quickPickItems = [
            {
                label: `Today's Spend: $${summary.dailySpend.toFixed(4)} / $${summary.dailyLimit.toFixed(2)}`,
                detail: `Daily budget consumption: ${Math.round((summary.dailySpend / (summary.dailyLimit || 10.0)) * 100)}%`
            },
            {
                label: `Total Prevented Cost: $${summary.preventedSpend.toFixed(4)}`,
                detail: 'Savings from blocked runaway loops or budget blocks'
            },
            {
                label: `Total Optimized Savings: $${summary.optimizedSavings.toFixed(4)}`,
                detail: `Saved ${summary.savedTokens.toLocaleString()} tokens via prompt compressions / switches`
            },
            {
                label: '--- Workspace Attribution ---',
                kind: vscode.QuickPickItemKind.Separator
            },
            ...summary.workspaces.map(w => ({
                label: `  ${w.project_name}`,
                detail: `Accumulated Spend: $${w.total_spend.toFixed(4)}`
            })),
            {
                label: '--- Provider Breakdown ---',
                kind: vscode.QuickPickItemKind.Separator
            },
            ...summary.providers.map(p => ({
                label: `  ${p.provider.toUpperCase()}`,
                detail: `Spend: $${p.total_spend.toFixed(4)} (${p.request_count} requests)`
            })),
            {
                label: '--- Model Breakdown ---',
                kind: vscode.QuickPickItemKind.Separator
            },
            ...summary.models.map(m => ({
                label: `  ${m.model}`,
                detail: `Spend: $${m.total_spend.toFixed(4)} (${m.request_count} requests)`
            }))
        ];
        vscode.window.showQuickPick(quickPickItems, {
            title: `TokenWall Summary • Total Savings: $${totalSaved.toFixed(2)}`,
            placeHolder: 'Select any item to close status'
        });
    }
    catch (err) {
        vscode.window.showErrorMessage(`Failed to fetch stats: ${err.message}`);
    }
}
// -------------------------------------------------------------
// Local Configuration Sync
// -------------------------------------------------------------
function syncSettingsToConfigFile() {
    try {
        const configDir = path.join(os.homedir(), '.tokenwall');
        const configPath = path.join(configDir, 'config.json');
        let current = {};
        if (fs.existsSync(configPath)) {
            try {
                current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
            catch { }
        }
        const settings = vscode.workspace.getConfiguration('tokenwall');
        current.dailyLimit = settings.get('dailyLimit', 10.0);
        current.monthlyLimit = settings.get('monthlyLimit', 100.0);
        current.sessionLimit = settings.get('sessionLimit', 2.0);
        current.hardLimitsEnabled = settings.get('hardLimitsEnabled', true);
        current.autoApproveLimit = settings.get('autoApproveLimit', 0.10);
        current.autoDenyLimit = settings.get('autoDenyLimit', 5.00);
        current.autoOptimize = settings.get('autoOptimize', true);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
        console.log('Synchronized VS Code settings with ~/.tokenwall/config.json');
    }
    catch (err) {
        console.error('Error synchronizing TokenWall configuration settings', err);
    }
}
async function autoConfigureAIExtensions() {
    const extensions = vscode.extensions.all;
    // 1. Check for Cline
    const clineExt = extensions.find(e => e.id === 'saoudrizwan.claude-dev');
    if (clineExt) {
        const config = vscode.workspace.getConfiguration('cline');
        const provider = config.get('apiProvider');
        if (provider !== 'custom') {
            const opt = await vscode.window.showInformationMessage('TokenWall detected the Cline extension. Enable automatic spend protection and loop blocking for Cline?', 'Enable Protection', 'No');
            if (opt === 'Enable Protection') {
                await config.update('apiProvider', 'custom', vscode.ConfigurationTarget.Global);
                await config.update('apiEndpoint', 'http://localhost:1984/v1', vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('TokenWall spend protection enabled for Cline!');
            }
        }
    }
    // 2. Check for Roo Cline
    const rooClineExt = extensions.find(e => e.id === 'RooVeterinaryInc.roo-cline');
    if (rooClineExt) {
        const config = vscode.workspace.getConfiguration('roo-cline');
        const provider = config.get('apiProvider');
        if (provider !== 'custom') {
            const opt = await vscode.window.showInformationMessage('TokenWall detected the Roo Cline extension. Enable automatic spend protection and loop blocking for Roo Cline?', 'Enable Protection', 'No');
            if (opt === 'Enable Protection') {
                await config.update('apiProvider', 'custom', vscode.ConfigurationTarget.Global);
                await config.update('apiEndpoint', 'http://localhost:1984/v1', vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('TokenWall spend protection enabled for Roo Cline!');
            }
        }
    }
    // 3. Check for Claude Code extension
    const claudeCodeExt = extensions.find(e => e.id === 'anthropic.claude-code' || e.id.includes('claude-code'));
    if (claudeCodeExt) {
        const config = vscode.workspace.getConfiguration('claude-code');
        let envVars = config.get('environmentVariables') || [];
        const hasBaseUrl = envVars.some(v => v.name === 'ANTHROPIC_BASE_URL');
        if (!hasBaseUrl) {
            const opt = await vscode.window.showInformationMessage('TokenWall detected the Claude Code extension. Enable automatic spend protection and loop blocking for Claude Code?', 'Enable Protection', 'No');
            if (opt === 'Enable Protection') {
                const updatedEnvVars = [...envVars];
                updatedEnvVars.push({ name: 'ANTHROPIC_BASE_URL', value: 'http://localhost:1984' });
                await config.update('environmentVariables', updatedEnvVars, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('TokenWall spend protection enabled for Claude Code!');
            }
        }
    }
}
//# sourceMappingURL=extension.js.map