import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';

let daemonProcess: ChildProcess | null = null;
let wsClient: WebSocket | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let isConnected = false;

export function activate(context: vscode.ExtensionContext) {
  console.log('TokenWall VS Code companion extension is now active.');

  // 1. Initialize Status Bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tokenwall.showStatus';
  context.subscriptions.push(statusBarItem);
  updateStatusBarText('Initializing...', 'yellow');
  statusBarItem.show();

  // 2. Setup environment interception
  updateTerminalEnvironment(context);

  // 3. Start Daemon Manager & Control Plane Listener
  startDaemonManager(context);
  connectControlPlane(context);

  // 4. Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('tokenwall.showStatus', async () => {
      await showStatusSummary();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenwall.restartDaemon', () => {
      restartDaemon(context);
    })
  );

  // 5. Watch settings configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tokenwall')) {
        updateTerminalEnvironment(context);
        syncSettingsToConfigFile();
      }
    })
  );

  // Perform initial config sync
  syncSettingsToConfigFile();
}

export function deactivate() {
  stopDaemon();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pollTimer) clearInterval(pollTimer);
}

// -------------------------------------------------------------
// Terminal Environment Injection
// -------------------------------------------------------------
function updateTerminalEnvironment(context: vscode.ExtensionContext) {
  const env = context.environmentVariableCollection;
  const config = vscode.workspace.getConfiguration('tokenwall');
  const enableInterception = config.get<boolean>('enableAutoInterception', true);

  if (enableInterception) {
    env.replace('ANTHROPIC_BASE_URL', 'http://localhost:1984');
    env.replace('OPENAI_BASE_URL', 'http://localhost:1984/v1');
    env.replace('GEMINI_BASE_URL', 'http://localhost:1984');
  } else {
    env.clear();
  }
}

// -------------------------------------------------------------
// Local Daemon Manager
// -------------------------------------------------------------
function startDaemonManager(context: vscode.ExtensionContext) {
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

async function checkDaemonHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    const res = await fetch('http://localhost:1984/api/admin/budgets', { signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok;
  } catch {
    return false;
  }
}

function launchDaemon(context: vscode.ExtensionContext) {
  if (daemonProcess) return;

  const localGateway = path.resolve(context.extensionPath, '../gateway/dist/index.js');
  
  let gatewayPath = '';
  if (fs.existsSync(localGateway)) {
    gatewayPath = localGateway;
  } else {
    // node_modules resolution
    const nodeModulesPath = path.resolve(context.extensionPath, 'node_modules/@tokenwall/gateway/dist/index.js');
    if (fs.existsSync(nodeModulesPath)) {
      gatewayPath = nodeModulesPath;
    }
  }

  console.log(`Starting TokenWall gateway daemon... Resolved path: ${gatewayPath}`);
  
  if (gatewayPath) {
    daemonProcess = spawn('node', [gatewayPath], {
      stdio: 'ignore',
      env: { ...process.env, PORT: '1984', TOKENWALL_HEADLESS: 'false' }
    });
  } else {
    // Fallback: spawn npx global launch
    daemonProcess = spawn('npx', ['tokenwall', 'start'], {
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
        if (!alive) launchDaemon(context);
      });
    }, 5000);
  });
}

function restartDaemon(context: vscode.ExtensionContext) {
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
function connectControlPlane(context: vscode.ExtensionContext) {
  if (wsClient) {
    try {
      wsClient.close();
    } catch {}
  }

  wsClient = new WebSocket('ws://localhost:1984/ws/control');

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
    } catch (e) {
      console.error('Failed to parse websocket message', e);
    }
  });

  wsClient.on('close', () => {
    isConnected = false;
    updateStatusBarText('Reconnecting...', 'yellow');
    
    // Retry connection after 3 seconds
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connectControlPlane(context);
    }, 3000);
  });

  wsClient.on('error', () => {
    isConnected = false;
  });
}

// -------------------------------------------------------------
// Native Modal Approval UI
// -------------------------------------------------------------
interface PendingApprovalRequest {
  requestId: string;
  projectId: string | null;
  sessionId: string;
  model: string;
  estimatedCost: number;
  warnings: string[];
  routingAlternatives?: Array<{
    model: string;
    estimatedCost: number;
    qualityLevel: string;
    savingsPercentage: number;
  }>;
}

async function handlePendingApproval(req: PendingApprovalRequest) {
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

  const selection = await vscode.window.showWarningMessage(
    `TokenWall Spend Intercept [${req.requestId}]\n` +
    `Model: ${req.model}\n` +
    `Estimated Cost: ${costText}` +
    warningsList,
    { modal: true },
    ...buttons
  );

  let action: 'approve' | 'optimize' | 'switch_model' | 'cancel' = 'cancel';
  let chosenModel: string | undefined = undefined;

  if (selection === 'Approve') {
    action = 'approve';
  } else if (selection === 'Optimize Prompt') {
    action = 'optimize';
  } else if (selection === 'Switch Model' && req.routingAlternatives) {
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
    } else {
      action = 'cancel';
    }
  }

  // Send resolution back to gateway control plane
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(
      JSON.stringify({
        type: 'approval_resolved',
        payload: {
          requestId: req.requestId,
          action,
          chosenModel
        }
      })
    );
  }
}

// -------------------------------------------------------------
// Live Observability Status Bar & Stats Fetch
// -------------------------------------------------------------
async function fetchStatsAndUpdateUI() {
  if (!isConnected) return;

  try {
    const res = await fetch('http://localhost:1984/api/admin/budgets');
    if (res.ok) {
      const budgets = await res.json() as Array<{
        period: string;
        limit_amount: number;
        current_spend: number;
      }>;
      
      const daily = budgets.find(b => b.period === 'daily');
      if (daily) {
        const text = `TokenWall: $${daily.current_spend.toFixed(2)}`;
        const warningPercent = daily.current_spend / daily.limit_amount;
        
        let color: 'green' | 'yellow' | 'red' = 'green';
        if (warningPercent >= 0.9) {
          color = 'red';
        } else if (warningPercent >= 0.7) {
          color = 'yellow';
        }
        updateStatusBarText(text, color);
      }
    }
  } catch {
    updateStatusBarText('Offline', 'red');
  }
}

function updateStatusBarText(text: string, color: 'green' | 'yellow' | 'red') {
  if (!statusBarItem) return;
  statusBarItem.text = `$(shield) ${text}`;
  
  if (color === 'red') {
    statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
  } else if (color === 'yellow') {
    statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  } else {
    statusBarItem.color = undefined;
  }
}

async function showStatusSummary() {
  try {
    const res = await fetch('http://localhost:1984/api/admin/budgets');
    if (!res.ok) {
      vscode.window.showErrorMessage('TokenWall Gateway daemon API is unreachable.');
      return;
    }

    const budgets = await res.json() as Array<{
      period: string;
      limit_amount: number;
      current_spend: number;
      hard_limit: number;
    }>;

    const quickPickItems = budgets.map((b) => ({
      label: `${b.period.toUpperCase()} Spend`,
      description: `$${b.current_spend.toFixed(4)} / $${b.limit_amount.toFixed(2)}`,
      detail: `Limit Type: ${b.hard_limit === 1 ? 'Hard Limit (Blocks)' : 'Soft Limit (Warn Only)'}`
    }));

    vscode.window.showQuickPick(quickPickItems, {
      title: 'TokenWall Budget Status Overview',
      placeHolder: 'Select item to refresh status'
    });
  } catch (err: any) {
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
    
    let current: any = {};
    if (fs.existsSync(configPath)) {
      try {
        current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {}
    }

    const settings = vscode.workspace.getConfiguration('tokenwall');
    
    current.dailyLimit = settings.get<number>('dailyLimit', 10.0);
    current.monthlyLimit = settings.get<number>('monthlyLimit', 100.0);
    current.sessionLimit = settings.get<number>('sessionLimit', 2.0);
    current.hardLimitsEnabled = settings.get<boolean>('hardLimitsEnabled', true);
    current.autoApproveLimit = settings.get<number>('autoApproveLimit', 0.10);
    current.autoDenyLimit = settings.get<number>('autoDenyLimit', 5.00);
    current.autoOptimize = settings.get<boolean>('autoOptimize', true);

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
    console.log('Synchronized VS Code settings with ~/.tokenwall/config.json');
  } catch (err) {
    console.error('Error synchronizing TokenWall configuration settings', err);
  }
}
