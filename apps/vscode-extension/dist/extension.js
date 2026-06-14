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
const activeQuickPicks = new Map();
let daemonOutputChannel = null;
let isDownloadingDaemon = false;
function activate(context) {
    console.log('TokenWall VS Code companion extension is now active.');
    // Diagnostic dump of active extensions
    try {
        const dumpPath = '/Users/shashankkumar/Documents/tokenWall/debug_extensions.json';
        const extInfo = vscode.extensions.all.map(e => ({
            id: e.id,
            displayName: e.packageJSON?.displayName || '',
            name: e.packageJSON?.name || ''
        }));
        fs.writeFileSync(dumpPath, JSON.stringify(extInfo, null, 2), 'utf8');
    }
    catch (e) {
        console.error('Failed to dump diagnostics', e);
    }
    // 1. Initialize Status Bar
    daemonOutputChannel = vscode.window.createOutputChannel('TokenWall Daemon');
    context.subscriptions.push(daemonOutputChannel);
    daemonOutputChannel.appendLine('TokenWall companion extension activated.');
    // Check Node availability
    (0, child_process_1.exec)('node --version', (err) => {
        if (err) {
            daemonOutputChannel?.appendLine('Warning: Node.js was not detected in the environment path.');
            vscode.window.showWarningMessage('TokenWall requires Node.js to run the spend protection daemon. Please ensure Node.js is installed on your system.');
        }
    });
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
        const res = await fetch('http://127.0.0.1:1984/api/admin/project/get-or-create', {
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
        env.replace('ANTHROPIC_BASE_URL', 'http://127.0.0.1:1984');
        env.replace('OPENAI_BASE_URL', 'http://127.0.0.1:1984/v1');
        env.replace('GEMINI_BASE_URL', 'http://127.0.0.1:1984');
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
        const res = await fetch('http://127.0.0.1:1984/api/admin/budgets', { signal: controller.signal });
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
        else {
            // Dev environment fallback
            const folders = vscode.workspace.workspaceFolders;
            if (folders) {
                for (const f of folders) {
                    const devPath = path.resolve(f.uri.fsPath, 'apps/gateway/dist/index.js');
                    if (fs.existsSync(devPath)) {
                        gatewayPath = devPath;
                        break;
                    }
                }
            }
        }
    }
    const config = vscode.workspace.getConfiguration('tokenwall');
    const customCommand = config.get('customDaemonCommand');
    daemonOutputChannel?.appendLine(`Starting TokenWall gateway daemon... Resolved path: ${gatewayPath}`);
    if (customCommand) {
        daemonOutputChannel?.appendLine(`Spawning custom daemon command: "${customCommand}"`);
        daemonProcess = (0, child_process_1.spawn)(customCommand, [], {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
            env: { ...process.env, PORT: '1984', TOKENWALL_HEADLESS: 'false' }
        });
    }
    else if (gatewayPath) {
        daemonOutputChannel?.appendLine(`Spawning local daemon via node: "${gatewayPath}"`);
        daemonProcess = (0, child_process_1.spawn)('node', [gatewayPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PORT: '1984', TOKENWALL_HEADLESS: 'false' }
        });
    }
    else {
        daemonOutputChannel?.appendLine('Spawning local daemon fallback via npx...');
        isDownloadingDaemon = true;
        updateStatusBarText('Downloading Daemon...', 'yellow');
        const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        daemonProcess = (0, child_process_1.spawn)(cmd, ['--yes', 'tokenwall', 'start'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PORT: '1984', TOKENWALL_HEADLESS: 'false' }
        });
    }
    daemonProcess.stdout?.on('data', (data) => {
        daemonOutputChannel?.appendLine(`[Daemon STDOUT] ${data.toString().trim()}`);
    });
    daemonProcess.stderr?.on('data', (data) => {
        daemonOutputChannel?.appendLine(`[Daemon STDERR] ${data.toString().trim()}`);
    });
    daemonProcess.on('error', (err) => {
        daemonOutputChannel?.appendLine(`[Daemon ERROR] Spawn/run error: ${err.message}`);
        vscode.window.showErrorMessage(`TokenWall companion extension failed to start background daemon: ${err.message}`);
    });
    daemonProcess.on('exit', (code) => {
        daemonOutputChannel?.appendLine(`[Daemon EXIT] Daemon exited with code ${code}`);
        daemonProcess = null;
        isDownloadingDaemon = false;
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
    wsClient = new ws_1.default('ws://127.0.0.1:1984/ws/control');
    wsClient.on('open', () => {
        isConnected = true;
        isDownloadingDaemon = false;
        console.log('WS Connection to TokenWall Control Plane established.');
        fetchStatsAndUpdateUI();
    });
    wsClient.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'approval_pending') {
                await handlePendingApproval(msg.payload);
            }
            else if (msg.type === 'approval_cleared') {
                const { requestId } = msg.payload;
                const qp = activeQuickPicks.get(requestId);
                if (qp) {
                    qp.hide();
                }
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
        ? `Warnings: ${req.warnings.map((w) => typeof w === 'string' ? w : w.description).join('; ')}`
        : '';
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = `TokenWall Intercept [${req.requestId}]`;
    quickPick.placeholder = `Model: ${req.model} | Cost: ${costText} ${warningsList ? ' | ' + warningsList : ''}`;
    const items = [
        { label: 'Approve', description: 'Proceed with this request' }
    ];
    if (req.warnings.length > 0) {
        items.push({ label: 'Optimize Prompt', description: 'Optimize prompt (strip waste) and proceed' });
    }
    if (req.routingAlternatives && req.routingAlternatives.length > 0) {
        items.push({ label: 'Switch Model', description: 'Switch to a cost-efficient model' });
    }
    items.push({ label: 'Cancel', description: 'Block this request' });
    quickPick.items = items;
    quickPick.ignoreFocusOut = true;
    activeQuickPicks.set(req.requestId, quickPick);
    let resolved = false;
    quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (!selected)
            return;
        resolved = true;
        quickPick.hide();
        let action = 'cancel';
        let chosenModel = undefined;
        if (selected.label === 'Approve') {
            action = 'approve';
        }
        else if (selected.label === 'Optimize Prompt') {
            action = 'optimize';
        }
        else if (selected.label === 'Switch Model' && req.routingAlternatives) {
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
    });
    quickPick.onDidHide(() => {
        if (!resolved) {
            if (wsClient && wsClient.readyState === ws_1.default.OPEN) {
                wsClient.send(JSON.stringify({
                    type: 'approval_resolved',
                    payload: {
                        requestId: req.requestId,
                        action: 'cancel'
                    }
                }));
            }
        }
        activeQuickPicks.delete(req.requestId);
        quickPick.dispose();
    });
    quickPick.show();
}
// -------------------------------------------------------------
// Live Observability Status Bar & Stats Fetch
// -------------------------------------------------------------
async function fetchStatsAndUpdateUI() {
    if (!isConnected)
        return;
    try {
        const res = await fetch('http://127.0.0.1:1984/api/admin/summary');
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
    if (isDownloadingDaemon && (text === 'Reconnecting...' || text === 'Offline')) {
        statusBarItem.text = `$(cloud-download) Downloading Daemon...`;
        statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        return;
    }
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
        const res = await fetch('http://127.0.0.1:1984/api/admin/summary');
        if (!res.ok) {
            vscode.window.showErrorMessage('TokenWall Gateway daemon API is unreachable.');
            return;
        }
        const summary = await res.json();
        const totalSaved = summary.preventedSpend + summary.optimizedSavings;
        const actionItems = [
            {
                label: `$(graph) Open Observability Dashboard`,
                detail: 'View detailed analytics and forensic logs',
                action: 'open_dashboard'
            },
            {
                label: `$(settings-gear) Configure TokenWall Limits`,
                detail: 'Set daily/monthly budgets and optimization preferences',
                action: 'configure_limits'
            },
            {
                label: '--- Spend Summary ---',
                kind: vscode.QuickPickItemKind.Separator
            }
        ];
        const quickPickItems = [
            ...actionItems,
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
        const picked = await vscode.window.showQuickPick(quickPickItems, {
            title: `TokenWall Summary • Total Savings: $${totalSaved.toFixed(2)}`,
            placeHolder: 'Select an action or view summary'
        });
        if (picked && picked.action) {
            if (picked.action === 'open_dashboard') {
                vscode.env.openExternal(vscode.Uri.parse('http://127.0.0.1:1984/dashboard/'));
            }
            else if (picked.action === 'configure_limits') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'tokenwall');
            }
        }
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
                await config.update('apiEndpoint', 'http://127.0.0.1:1984/v1', vscode.ConfigurationTarget.Global);
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
                await config.update('apiEndpoint', 'http://127.0.0.1:1984/v1', vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('TokenWall spend protection enabled for Roo Cline!');
            }
        }
    }
    // 3. Check for Claude Code extension
    const claudeCodeExt = extensions.find(e => e.id.toLowerCase() === 'anthropic.claude-code' || e.id.toLowerCase().includes('claude-code'));
    if (claudeCodeExt) {
        const config = vscode.workspace.getConfiguration('claude-code');
        let envVars = config.get('environmentVariables') || [];
        const hasBaseUrl = envVars.some(v => v.name === 'ANTHROPIC_BASE_URL');
        if (!hasBaseUrl) {
            const opt = await vscode.window.showInformationMessage('TokenWall detected the Claude Code extension. Enable automatic spend protection and loop blocking for Claude Code?', 'Enable Protection', 'No');
            if (opt === 'Enable Protection') {
                const updatedEnvVars = [...envVars];
                updatedEnvVars.push({ name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:1984' });
                await config.update('environmentVariables', updatedEnvVars, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('TokenWall spend protection enabled for Claude Code!');
            }
        }
    }
}
//# sourceMappingURL=extension.js.map