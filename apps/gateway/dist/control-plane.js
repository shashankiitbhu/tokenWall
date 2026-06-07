"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.controlPlane = exports.ControlPlane = void 0;
class ControlPlane {
    clients = new Set();
    pendingApprovals = new Map();
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
                        const { requestId, action } = data.payload;
                        const pending = this.pendingApprovals.get(requestId);
                        if (pending) {
                            pending.resolve(action);
                            this.pendingApprovals.delete(requestId);
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
        return new Promise((resolve) => {
            this.pendingApprovals.set(request.requestId, { request, resolve });
            this.broadcast({
                type: 'approval_pending',
                payload: request
            });
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
