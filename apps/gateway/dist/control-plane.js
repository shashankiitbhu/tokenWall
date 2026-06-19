"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.controlPlane = exports.ControlPlane = void 0;
const terminal_ui_1 = require("@tokenwall/terminal-ui");
class ControlPlane {
    clients = new Set();
    pendingApprovals = new Map();
    approvalCache = new Map();
    registerWebsocket(fastify) {
        fastify.get('/ws/control', { websocket: true }, (connection, req) => {
            console.log('WS Connection established on server');
            this.clients.add(connection.socket);
            // Send current pending queue to new client
            for (const pending of this.pendingApprovals.values()) {
                console.log('Sending pending approval to new client', pending.request.requestId);
                connection.socket.send(JSON.stringify({
                    type: 'approval_pending',
                    payload: pending.request
                }));
            }
            connection.socket.on('message', (message) => {
                try {
                    const data = JSON.parse(message.toString());
                    if (data.type === 'approval_resolved') {
                        const { requestId, action, chosenModel } = data.payload;
                        const pending = this.pendingApprovals.get(requestId);
                        if (pending) {
                            const req = pending.request;
                            pending.resolve({ action, chosenModel });
                            this.pendingApprovals.delete(requestId);
                            // Cache the approval for 2 minutes to handle client retries
                            if (action !== 'cancel') {
                                const cacheKey = `${req.sessionId}:${req.model}:${req.estimatedCost.toFixed(4)}`;
                                this.approvalCache.set(cacheKey, { action, chosenModel, expires: Date.now() + 120000 });
                            }
                            // Broadcast resolution to other clients
                            this.broadcast({ type: 'approval_cleared', payload: { requestId } });
                        }
                    }
                }
                catch (e) {
                    console.error('Invalid WS message', e);
                }
            });
            connection.socket.on('close', () => {
                this.clients.delete(connection.socket);
            });
        });
    }
    requestApproval(request) {
        console.log('Requesting approval for', request.requestId);
        const cacheKey = `${request.sessionId}:${request.model}:${request.estimatedCost.toFixed(4)}`;
        const cached = this.approvalCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            console.log(`Using cached approval for ${cacheKey}`);
            return Promise.resolve({ action: cached.action, chosenModel: cached.chosenModel });
        }
        // Fallback to native OS dialog if no WebSocket clients are connected
        if (this.clients.size === 0) {
            console.log('No control plane client connected. Falling back to native OS dialog...');
            return new Promise(async (resolve) => {
                const action = await terminal_ui_1.TerminalUI.askApproval(request.estimatedCost.toFixed(4), request.model);
                let chosenModel = undefined;
                if (action === 'switch_model' && request.routingAlternatives && request.routingAlternatives.length > 0) {
                    chosenModel = request.routingAlternatives[0].model;
                }
                if (action !== 'cancel') {
                    this.approvalCache.set(cacheKey, { action, chosenModel, expires: Date.now() + 120000 });
                }
                resolve({ action, chosenModel });
            });
        }
        return new Promise((resolve) => {
            this.pendingApprovals.set(request.requestId, { request, resolve });
            this.broadcast({
                type: 'approval_pending',
                payload: request
            });
        });
    }
    cancelApproval(requestId) {
        const pending = this.pendingApprovals.get(requestId);
        if (pending) {
            pending.resolve({ action: 'cancel' });
            this.pendingApprovals.delete(requestId);
            this.broadcast({ type: 'approval_cleared', payload: { requestId } });
        }
    }
    sendNotification(message, style = 'info') {
        this.broadcast({
            type: 'notification',
            payload: { message, style }
        });
    }
    broadcast(message) {
        const payload = JSON.stringify(message);
        for (const client of this.clients) {
            if (client.readyState === 1) { // OPEN
                client.send(payload);
            }
        }
    }
}
exports.ControlPlane = ControlPlane;
exports.controlPlane = new ControlPlane();
