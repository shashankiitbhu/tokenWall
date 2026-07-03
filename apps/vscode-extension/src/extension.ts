import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, exec, ChildProcess } from 'child_process';
import WebSocket from 'ws';

let daemonProcess: ChildProcess | null = null;
let wsClient: WebSocket | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let isConnected = false;
const activeQuickPicks = new Map<string, any>();
let daemonOutputChannel: vscode.OutputChannel | null = null;
let isDownloadingDaemon = false;
let daemonCrashCount = 0;
let isSpawning = false;
let intentionalStop = false;

// Task Savings Tracking
let previousSavedTokens = 0;
let accumulatedTaskTokens = 0;
let taskIdleTimer: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('TokenWall VS Code companion extension is now active.');

  // 0. Transparently intercept global fetch for all extensions in this host
  interceptExtensionHostTraffic();

  // Diagnostic dump of active extensions
  try {
    const dumpPath = '/Users/shashankkumar/Documents/tokenWall/debug_extensions.json';
    const extInfo = vscode.extensions.all.map(e => ({
      id: e.id,
      displayName: e.packageJSON?.displayName || '',
      name: e.packageJSON?.name || ''
    }));
    fs.writeFileSync(dumpPath, JSON.stringify(extInfo, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to dump diagnostics', e);
  }

  // 1. Initialize Status Bar
  daemonOutputChannel = vscode.window.createOutputChannel('TokenWall Daemon');
  context.subscriptions.push(daemonOutputChannel);
  daemonOutputChannel.appendLine('TokenWall companion extension activated.');

  // Check Node availability
  exec('node --version', (err) => {
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
        updateTerminalEnvironment(context).catch(console.error);
        syncSettingsToConfigFile();
      }
    })
  );

  // Perform initial config sync
  syncSettingsToConfigFile();

  // Auto-detect and configure other popular AI extensions
  autoConfigureAIExtensions().catch(console.error);
}

export function deactivate() {
  stopDaemon();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pollTimer) clearInterval(pollTimer);
}

// -------------------------------------------------------------
// Terminal Environment Injection
// -------------------------------------------------------------
async function getOrCreateWorkspaceProject(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
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
      const proj = await res.json() as { id: string };
      return proj.id;
    }
  } catch (e) {
    console.error('Failed to register project folder with gateway', e);
  }
  return null;
}

async function updateTerminalEnvironment(context: vscode.ExtensionContext) {
  const env = context.environmentVariableCollection;
  const config = vscode.workspace.getConfiguration('tokenwall');
  const enableInterception = config.get<boolean>('enableAutoInterception', true);

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
    } catch {}
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
    const res = await fetch('http://127.0.0.1:1984/api/admin/budgets', { signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok;
  } catch {
    return false;
  }
}

function launchDaemon(context: vscode.ExtensionContext) {
  if (daemonProcess || isSpawning) return;
  isSpawning = true;
  intentionalStop = false;

  const localGateway = path.resolve(context.extensionPath, '../gateway/dist/index.js');
  
  let gatewayPath = '';
  if (fs.existsSync(localGateway)) {
    gatewayPath = localGateway;
  } else {
    // node_modules resolution
    const nodeModulesPath = path.resolve(context.extensionPath, 'node_modules/@tokenwall/gateway/dist/index.js');
    if (fs.existsSync(nodeModulesPath)) {
      gatewayPath = nodeModulesPath;
    } else {
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
  const customCommand = config.get<string>('customDaemonCommand');

  daemonOutputChannel?.appendLine(`[Daemon Manager] Preparing to start background daemon...`);

  // Build the list of strategies to try in order
  const strategies: { name: string; cmd: string; args: string[]; useShell?: boolean }[] = [];

  if (customCommand) {
    strategies.push({ name: 'customCommand', cmd: customCommand, args: [], useShell: true });
  }

  if (gatewayPath) {
    strategies.push({ name: 'localGateway', cmd: 'node', args: [gatewayPath] });
  } else {
    if (process.platform === 'win32') {
      // On Windows, VS Code's extension host may not have npm's global bin
      // in its PATH. Try the explicit %APPDATA%\npm path first.
      const appData = process.env.APPDATA;
      if (appData) {
        const explicitCmd = path.join(appData, 'npm', 'tokenwall.cmd');
        const fs = require('fs');
        if (fs.existsSync(explicitCmd)) {
          strategies.push({ name: 'globalTokenWall', cmd: explicitCmd, args: ['start'] });
        }
      }
      // Also try PATH-based resolution
      strategies.push({ name: 'globalTokenWall', cmd: 'tokenwall.cmd', args: ['start'] });
    } else {
      strategies.push({ name: 'globalTokenWall', cmd: 'tokenwall', args: ['start'] });
    }

    // Fall back to npx
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    strategies.push({ name: 'npxFallback', cmd: npxCmd, args: ['--yes', 'tokenwall', 'start'] });
  }

  // On Windows, build an enhanced PATH that includes npm's global bin directory
  const spawnEnv: Record<string, string | undefined> = { ...process.env, PORT: '1984', TOKENWALL_HEADLESS: 'false' };
  if (process.platform === 'win32' && process.env.APPDATA) {
    const npmGlobalBin = path.join(process.env.APPDATA, 'npm');
    // Find the actual PATH key (Windows uses 'Path', not 'PATH')
    const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'Path';
    const currentPath = spawnEnv[pathKey] || '';
    if (!currentPath.includes(npmGlobalBin)) {
      spawnEnv[pathKey] = `${npmGlobalBin};${currentPath}`;
      daemonOutputChannel?.appendLine(`[Daemon Manager] Added npm global bin to PATH: ${npmGlobalBin}`);
    }
  }

  function attemptSpawn(index: number) {
    if (index >= strategies.length) {
      daemonOutputChannel?.appendLine('[Daemon Manager] All spawn strategies failed.');
      isSpawning = false;
      isDownloadingDaemon = false;
      updateStatusBarText('Offline', 'red');
      
      daemonCrashCount++;
      handleCrash();
      return;
    }

    const strategy = strategies[index];
    daemonOutputChannel?.appendLine(`[Daemon Manager] Attempting strategy "${strategy.name}": ${strategy.cmd} ${strategy.args.join(' ')}`);

    if (strategy.name === 'npxFallback') {
      isDownloadingDaemon = true;
      updateStatusBarText('Downloading Daemon...', 'yellow');
    }

    let hasFailed = false;
    const startTime = Date.now();

    const child = spawn(strategy.cmd, strategy.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: strategy.useShell || process.platform === 'win32',
      env: spawnEnv
    });

    daemonProcess = child;

    child.stdout?.on('data', (data) => {
      daemonOutputChannel?.appendLine(`[Daemon STDOUT] ${data.toString().trim()}`);
    });

    child.stderr?.on('data', (data) => {
      daemonOutputChannel?.appendLine(`[Daemon STDERR] ${data.toString().trim()}`);
    });

    child.on('error', (err: any) => {
      daemonOutputChannel?.appendLine(`[Daemon ERROR] Strategy "${strategy.name}" failed: ${err.message}`);
      if (hasFailed) return;
      hasFailed = true;
      daemonProcess = null;
      // Immediately try next strategy
      attemptSpawn(index + 1);
    });

    child.on('exit', (code) => {
      daemonOutputChannel?.appendLine(`[Daemon EXIT] Strategy "${strategy.name}" exited with code ${code}`);
      if (hasFailed) return;
      hasFailed = true;
      daemonProcess = null;
      isDownloadingDaemon = false;
      updateStatusBarText('Offline', 'red');

      if (intentionalStop) {
        daemonOutputChannel?.appendLine('[Daemon Manager] Daemon was stopped intentionally. Auto-recovery skipped.');
        intentionalStop = false;
        isSpawning = false;
        return;
      }

      const duration = Date.now() - startTime;
      if (code !== 0 && duration < 3000) {
        daemonOutputChannel?.appendLine(`[Daemon Manager] Strategy "${strategy.name}" failed quickly. Trying next strategy...`);
        attemptSpawn(index + 1);
      } else {
        if (duration < 5000) {
          daemonCrashCount++;
        } else {
          daemonCrashCount = 0; // Reset on clean run
        }
        handleCrash();
      }
    });
  }

  function handleCrash() {
    isSpawning = false;

    if (daemonCrashCount >= 3) {
      daemonOutputChannel?.appendLine(`[Daemon Manager] Daemon crashed ${daemonCrashCount} times consecutively. Disabling auto-recovery.`);
      vscode.window.showErrorMessage(
        'TokenWall spend protection daemon failed to start. Please verify your Node/npm environment. You can try installing the package globally, or checking the logs.',
        'Retry', 'Show Logs', 'Copy Install Command'
      ).then((selection) => {
        if (selection === 'Retry') {
          daemonCrashCount = 0;
          launchDaemon(context);
        } else if (selection === 'Show Logs') {
          daemonOutputChannel?.show();
        } else if (selection === 'Copy Install Command') {
          vscode.env.clipboard.writeText('npm install -g tokenwall');
          vscode.window.showInformationMessage('Copied "npm install -g tokenwall" to clipboard.');
        }
      });
      return;
    }

    const delays = [5000, 15000, 30000];
    const delay = delays[Math.min(daemonCrashCount, delays.length - 1)];
    daemonOutputChannel?.appendLine(`[Daemon Manager] Auto-recovery: waiting ${delay / 1000}s before checking/relaunching...`);

    setTimeout(() => {
      checkDaemonHealth().then((alive) => {
        if (!alive) launchDaemon(context);
      });
    }, delay);
  }

  attemptSpawn(0);
}

function restartDaemon(context: vscode.ExtensionContext) {
  stopDaemon();
  vscode.window.showInformationMessage('Restarting TokenWall gateway daemon...');
  daemonCrashCount = 0;
  isSpawning = false;
  setTimeout(() => launchDaemon(context), 1500);
}

function stopDaemon() {
  if (daemonProcess) {
    intentionalStop = true;
    daemonProcess.kill();
    daemonProcess = null;
  }
}

// -------------------------------------------------------------
// WebSocket Control Plane IPC Client
// -------------------------------------------------------------

function connectControlPlane(context: vscode.ExtensionContext) {
  if (wsClient) {
    try { wsClient.close(); } catch {}
  }

  wsClient = new WebSocket('ws://127.0.0.1:1984/ws/control');

  wsClient.on('open', () => {
    isConnected = true;
    isDownloadingDaemon = false;
    daemonCrashCount = 0;
    isSpawning = false;
    console.log('WS Connection to TokenWall Control Plane established.');
    updateStatusBarText('Active', 'green');
    fetchStatsAndUpdateUI();
    
    // Start ping interval
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.ping();
      }
    }, 15000); // 15 second ping to keep connection alive
  });

  wsClient.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'approval_pending') {
        const req = msg.payload as PendingApprovalRequest;
        if (!activeQuickPicks.has(req.requestId)) {
          handlePendingApproval(req);
        }
      } else if (msg.type === 'approval_cleared') {
        const { requestId } = msg.payload;
        const qp = activeQuickPicks.get(requestId);
        if (qp) {
          qp.hide();
        }
      } else if (msg.type === 'notification') {
        const { message, style } = msg.payload;
        if (style === 'error') {
          vscode.window.showErrorMessage(message);
        } else if (style === 'warning') {
          vscode.window.showWarningMessage(message);
        } else {
          vscode.window.showInformationMessage(message);
        }
      }
    } catch (err) {
      console.error('Invalid WS message', err);
    }
  });

  wsClient.on('close', () => {
    isConnected = false;
    if (pingInterval) clearInterval(pingInterval);
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

let isShowingQuickPick = false;
const pendingQueue: PendingApprovalRequest[] = [];

async function processQueue() {
  if (isShowingQuickPick || pendingQueue.length === 0) return;
  isShowingQuickPick = true;
  
  try {
    const req = pendingQueue.shift()!;
    await showApprovalUI(req);
  } finally {
    isShowingQuickPick = false;
    if (pendingQueue.length > 0) {
      setTimeout(processQueue, 100);
    }
  }
}

function showApprovalUI(req: PendingApprovalRequest): Promise<void> {
  return new Promise((resolve) => {
    const costText = `$${req.estimatedCost.toFixed(4)}`;

    const quickPick = vscode.window.createQuickPick();
    quickPick.title = `🛡️ TokenWall Spend Intercept — ${req.model}`;
    quickPick.placeholder = `Estimated request cost is ${costText}. Choose an action below:`;

    const items: vscode.QuickPickItem[] = [];

    items.push({
      label: `$(zap) Optimize Prompt & Proceed`,
      description: 'Strip comments, minify JSON, and align cache prefixes losslessly',
      detail: 'Bypasses waste to decrease latency and reduce token cost'
    });

    items.push({
      label: `$(check) Approve As-Is`,
      description: 'Proceed with this request as-is without optimizing context',
      detail: `Proceed at full estimated cost of ${costText}`
    });

    if (req.routingAlternatives && req.routingAlternatives.length > 0) {
      items.push({
        label: `$(git-compare) Switch Model`,
        description: 'Switch to a cost-efficient model alternative',
        detail: `Alternatives: ${req.routingAlternatives.map(alt => `${alt.model} (${alt.savingsPercentage}% saved)`).join(', ')}`
      });
    }

    items.push({
      label: `$(x) Block Request`,
      description: 'Block this request from hitting the provider API',
      detail: 'Terminates this call to preserve remaining budget'
    });

    if (req.warnings && req.warnings.length > 0) {
      items.push({
        label: '⚠️ Spend Warnings & Inefficiencies Detected',
        kind: vscode.QuickPickItemKind.Separator
      });
      for (const w of req.warnings) {
        const desc = typeof w === 'string' ? w : (w as any).description || JSON.stringify(w);
        items.push({
          label: `  ${desc}`,
          alwaysShow: true
        });
      }
    }

    quickPick.items = items;
    quickPick.ignoreFocusOut = true;

    activeQuickPicks.set(req.requestId, quickPick);

    let isResolving = false;

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (!selected || selected.kind === vscode.QuickPickItemKind.Separator || selected.label.startsWith('  ')) return;

      isResolving = true;
      quickPick.hide();

      let action: 'approve' | 'optimize' | 'switch_model' | 'cancel' = 'cancel';
      let chosenModel: string | undefined = undefined;

      if (selected.label.includes('Approve As-Is')) {
        action = 'approve';
      } else if (selected.label.includes('Optimize Prompt')) {
        action = 'optimize';
      } else if (selected.label.includes('Switch Model') && req.routingAlternatives) {
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
      
      activeQuickPicks.delete(req.requestId);
      quickPick.dispose();
      resolve();
    });

    quickPick.onDidHide(() => {
      if (!isResolving) {
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(
            JSON.stringify({
              type: 'approval_resolved',
              payload: {
                requestId: req.requestId,
                action: 'cancel'
              }
            })
          );
        }
        activeQuickPicks.delete(req.requestId);
        quickPick.dispose();
        resolve();
      }
    });

    quickPick.show();
  });
}

async function handlePendingApproval(req: PendingApprovalRequest) {
  pendingQueue.push(req);
  processQueue();
}

// -------------------------------------------------------------
// Live Observability Status Bar & Stats Fetch
// -------------------------------------------------------------
async function fetchStatsAndUpdateUI() {
  if (!isConnected) return;

  try {
    const res = await fetch('http://127.0.0.1:1984/api/admin/summary');
    if (res.ok) {
      const summary = await res.json() as {
        dailySpend: number;
        dailyLimit: number;
        preventedSpend: number;
        optimizedSavings: number;
        savedTokens: number;
      };
      
      const totalSaved = summary.preventedSpend + summary.optimizedSavings;
      const text = `Today: $${summary.dailySpend.toFixed(2)} • Saved: $${totalSaved.toFixed(2)}`;
      const warningPercent = summary.dailySpend / (summary.dailyLimit || 10.0);
      
      let color: 'green' | 'yellow' | 'red' = 'green';
      if (warningPercent >= 0.9) {
        color = 'red';
      } else if (warningPercent >= 0.7) {
        color = 'yellow';
      }
      updateStatusBarText(text, color);
      
      // Task Accumulator logic
      if (summary.savedTokens > previousSavedTokens) {
        // If this is the first time, don't show a massive toast of historic savings
        if (previousSavedTokens > 0) {
          const delta = summary.savedTokens - previousSavedTokens;
          accumulatedTaskTokens += delta;
          
          if (taskIdleTimer) clearTimeout(taskIdleTimer);
          
          // Wait 15 seconds after the last savings bump before showing the toast
          taskIdleTimer = setTimeout(() => {
            if (accumulatedTaskTokens > 0) {
              vscode.window.showInformationMessage(`TokenWall saved you ${accumulatedTaskTokens.toLocaleString()} tokens on your last AI task!`);
              accumulatedTaskTokens = 0;
            }
          }, 15000);
        }
        previousSavedTokens = summary.savedTokens;
      }

    }
  } catch {
    updateStatusBarText('Offline', 'red');
  }
}

function updateStatusBarText(text: string, color: 'green' | 'yellow' | 'red') {
  if (!statusBarItem) return;
  
  if (isDownloadingDaemon && (text === 'Reconnecting...' || text === 'Offline')) {
    statusBarItem.text = `$(cloud-download) Downloading Daemon...`;
    statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    return;
  }

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
    const res = await fetch('http://127.0.0.1:1984/api/admin/summary');
    if (!res.ok) {
      vscode.window.showErrorMessage('TokenWall Gateway daemon API is unreachable.');
      return;
    }

    const summary = await res.json() as {
      dailySpend: number;
      dailyLimit: number;
      preventedSpend: number;
      optimizedSavings: number;
      savedTokens: number;
      workspaces: Array<{ project_name: string; total_spend: number }>;
      providers: Array<{ provider: string; total_spend: number; request_count: number }>;
      models: Array<{ model: string; total_spend: number; request_count: number }>;
    };

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

    const picked = await vscode.window.showQuickPick(quickPickItems as any, {
      title: `TokenWall Summary • Total Savings: $${totalSaved.toFixed(2)}`,
      placeHolder: 'Select an action or view summary'
    });

    if (picked && (picked as any).action) {
      if ((picked as any).action === 'open_dashboard') {
        vscode.env.openExternal(vscode.Uri.parse('http://127.0.0.1:1984/dashboard/'));
      } else if ((picked as any).action === 'configure_limits') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'tokenwall');
      }
    }
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
    current.autoOptimize = settings.get<boolean>('autoOptimize', false);

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
    console.log('Synchronized VS Code settings with ~/.tokenwall/config.json');
  } catch (err) {
    console.error('Error synchronizing TokenWall configuration settings', err);
  }
}

async function autoConfigureAIExtensions() {
  const extensions = vscode.extensions.all;
  
  // 1. Check for Cline
  const clineExt = extensions.find(e => e.id === 'saoudrizwan.claude-dev');
  if (clineExt) {
    const config = vscode.workspace.getConfiguration('cline');
    const provider = config.get<string>('apiProvider');
    if (provider !== 'custom') {
      const opt = await vscode.window.showInformationMessage(
        'TokenWall detected the Cline extension. Enable automatic spend protection and loop blocking for Cline?',
        'Enable Protection',
        'No'
      );
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
    const provider = config.get<string>('apiProvider');
    if (provider !== 'custom') {
      const opt = await vscode.window.showInformationMessage(
        'TokenWall detected the Roo Cline extension. Enable automatic spend protection and loop blocking for Roo Cline?',
        'Enable Protection',
        'No'
      );
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
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let hasBaseUrl = false;
    let claudeSettings: any = {};
    
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
        if (claudeSettings.env && claudeSettings.env.ANTHROPIC_BASE_URL) {
          hasBaseUrl = true;
        }
      } catch (e) {
        console.error('Failed to parse ~/.claude/settings.json', e);
      }
    }

    if (!hasBaseUrl) {
      const opt = await vscode.window.showInformationMessage(
        'TokenWall detected the Claude Code extension. Enable automatic spend protection and loop blocking for Claude Code?',
        'Enable Protection',
        'No'
      );
      if (opt === 'Enable Protection') {
        if (!claudeSettings.env) {
          claudeSettings.env = {};
        }
        claudeSettings.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1984';
        
        try {
          const claudeDir = path.dirname(claudeSettingsPath);
          if (!fs.existsSync(claudeDir)) {
            fs.mkdirSync(claudeDir, { recursive: true });
          }
          fs.writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2), 'utf8');
          vscode.window.showInformationMessage('TokenWall spend protection enabled for Claude Code!');
        } catch (e) {
          console.error('Failed to update ~/.claude/settings.json', e);
          vscode.window.showErrorMessage('Failed to configure Claude Code. Please manually add ANTHROPIC_BASE_URL to your ~/.claude/settings.json.');
        }
      }
    }
  }

  // 4. Check for Antigravity IDE / extension
  const isAntigravity = vscode.env.appName.toLowerCase().includes('antigravity') || 
                        extensions.some(e => e.id.toLowerCase().includes('antigravity'));
  if (isAntigravity) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const workspaceRoot = folders[0].uri.fsPath;
      const envPath = path.join(workspaceRoot, '.env');
      let envContent = '';
      let needsConfig = true;
      
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
        if (envContent.includes('GEMINI_BASE_URL') || envContent.includes('ANTHROPIC_BASE_URL') || envContent.includes('OPENAI_BASE_URL')) {
          needsConfig = false;
        }
      }
      
      if (needsConfig) {
        const opt = await vscode.window.showInformationMessage(
          'TokenWall detected Antigravity IDE. Enable automatic spend protection and loop blocking for the Antigravity agent in this workspace?',
          'Enable Protection',
          'No'
        );
        if (opt === 'Enable Protection') {
          const linesToAdd = [
            '',
            '# TokenWall Interception Overrides',
            'GEMINI_BASE_URL=http://127.0.0.1:1984',
            'ANTHROPIC_BASE_URL=http://127.0.0.1:1984',
            'OPENAI_BASE_URL=http://127.0.0.1:1984/v1',
            ''
          ];
          fs.appendFileSync(envPath, linesToAdd.join('\n'), 'utf8');
          vscode.window.showInformationMessage('TokenWall spend protection enabled for Antigravity in this workspace! Please restart the agent/terminal to apply.');
        }
      }
    }
  }
}

// -------------------------------------------------------------
// Global Extension Host Network Interception
// -------------------------------------------------------------
function interceptExtensionHostTraffic() {
  const originalFetch = global.fetch;
  if (!originalFetch) return;

  global.fetch = async function (input: any, init?: any): Promise<Response> {
    try {
      let urlStr = '';
      if (typeof input === 'string') {
        urlStr = input;
      } else if (input instanceof URL) {
        urlStr = input.toString();
      } else if (input && typeof input === 'object' && input.url) {
        urlStr = input.url;
      }

      if (urlStr) {
        const urlObj = new URL(urlStr);
        const host = urlObj.hostname.toLowerCase();
        
        // Target AI provider hosts
        if (
          host === 'api.anthropic.com' ||
          host === 'api.openai.com' ||
          host === 'generativelanguage.googleapis.com'
        ) {
          // Reroute to local TokenWall Gateway
          const newUrl = new URL(urlObj.pathname + urlObj.search, 'http://127.0.0.1:1984');
          
          let currentHeaders: Headers;
          
          // 1. Extract headers safely from init or input
          if (init && init.headers) {
            currentHeaders = new Headers(init.headers);
          } else if (input && typeof input === 'object' && input.headers) {
            currentHeaders = new Headers(input.headers);
          } else {
            currentHeaders = new Headers();
          }
          
          // 2. Add our interceptor header
          currentHeaders.set('x-tokenwall-intercepted', 'true');
          
          // 3. Modify input and init transparently
          if (typeof input === 'string' || input instanceof URL) {
            input = newUrl.toString();
          } else if (input && typeof input === 'object' && input.url) {
            input = new Request(newUrl.toString(), input as any);
          }
          
          init = init || {};
          init.headers = currentHeaders;
          
          daemonOutputChannel?.appendLine(`[TokenWall Interceptor] Transparently rerouted ${host} -> 127.0.0.1:1984`);
        }
      }
    } catch (e) {
      console.error('[TokenWall] Fetch intercept error:', e);
    }
    
    return originalFetch(input, init);
  };
  
  console.log('TokenWall global.fetch interceptor installed.');
}

