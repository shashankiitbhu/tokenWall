import { FastifyInstance } from 'fastify';
import { TerminalUI } from '@tokenwall/terminal-ui';

export interface ApprovalRequest {
  requestId: string;
  projectId: string | null;
  sessionId: string;
  model: string;
  estimatedCost: number;
  warnings: any[];
  routingAlternatives?: any[];
}

export class ControlPlane {
  private clients: Set<any> = new Set();
  private pendingApprovals: Map<string, {
    request: ApprovalRequest;
    resolve: (result: { action: 'approve' | 'optimize' | 'switch_model' | 'cancel', chosenModel?: string }) => void;
  }> = new Map();
  private approvalCache: Map<string, { action: any, chosenModel: any, expires: number }> = new Map();
  private inflightApprovals: Map<string, Promise<{ action: 'approve' | 'optimize' | 'switch_model' | 'cancel', chosenModel?: string }>> = new Map();

  registerWebsocket(fastify: FastifyInstance) {
    fastify.get('/ws/control', { websocket: true } as any, (connection: any, req: any) => {
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

      connection.socket.on('message', (message: string) => {
        try {
          const data = JSON.parse(message.toString());
          if (data.type === 'approval_resolved') {
            const { requestId, action, chosenModel } = data.payload;
            const pending = this.pendingApprovals.get(requestId);
            if (pending) {
              const req = pending.request;
              pending.resolve({ action, chosenModel });
              this.pendingApprovals.delete(requestId);
              // Cache the approval for 60 seconds to handle client retries
              if (action !== 'cancel') {
                const approxCost = (Math.round(req.estimatedCost * 100) / 100).toFixed(2);
                const cacheKey = `${req.sessionId}:${req.model}:${approxCost}`;
                this.approvalCache.set(cacheKey, { action, chosenModel, expires: Date.now() + 60000 });
              }
              // Broadcast resolution to other clients
              this.broadcast({ type: 'approval_cleared', payload: { requestId } });
            }
          }
        } catch (e) {
          console.error('Invalid WS message', e);
        }
      });

      connection.socket.on('close', () => {
        this.clients.delete(connection.socket);
      });
    });
  }

  requestApproval(request: ApprovalRequest): Promise<{ action: 'approve' | 'optimize' | 'switch_model' | 'cancel', chosenModel?: string }> {
    console.log('Requesting approval for', request.requestId);
    
    // Use an approximate cost (rounded to 2 decimals) so that minor token fluctuations 
    // (like timestamps injected by Claude Code on retries) still hit the cache!
    const approxCost = (Math.round(request.estimatedCost * 100) / 100).toFixed(2);
    const cacheKey = `${request.sessionId}:${request.model}:${approxCost}`;
    
    const cached = this.approvalCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      console.log(`Using cached approval for ${cacheKey}`);
      return Promise.resolve({ action: cached.action, chosenModel: cached.chosenModel });
    }

    // Promise Coalescing: If there is already an in-flight approval for this exact cache key, wait for it!
    const inflight = this.inflightApprovals.get(cacheKey);
    if (inflight) {
      console.log(`Waiting for in-flight approval for ${cacheKey} (requestId: ${request.requestId})`);
      return inflight;
    }

    // Fallback to native OS dialog if no WebSocket clients are connected
    if (this.clients.size === 0) {
      console.log('No control plane client connected. Falling back to native OS dialog...');
      const promise = new Promise<{ action: 'approve' | 'optimize' | 'switch_model' | 'cancel', chosenModel?: string }>(async (resolve) => {
        const action = await TerminalUI.askApproval(request.estimatedCost.toFixed(4), request.model);
        let chosenModel: string | undefined = undefined;
        if (action === 'switch_model' && request.routingAlternatives && request.routingAlternatives.length > 0) {
          chosenModel = request.routingAlternatives[0].model;
        }
        if (action !== 'cancel') {
          this.approvalCache.set(cacheKey, { action, chosenModel, expires: Date.now() + 60000 });
        }
        this.inflightApprovals.delete(cacheKey);
        resolve({ action, chosenModel });
      });
      this.inflightApprovals.set(cacheKey, promise);
      return promise;
    }

    const promise = new Promise<{ action: 'approve' | 'optimize' | 'switch_model' | 'cancel', chosenModel?: string }>((resolve) => {
      this.pendingApprovals.set(request.requestId, { 
        request, 
        resolve: (result) => {
          this.inflightApprovals.delete(cacheKey);
          resolve(result);
        }
      });
      this.broadcast({
        type: 'approval_pending',
        payload: request
      });
    });
    
    this.inflightApprovals.set(cacheKey, promise);
    return promise;
  }

  cancelApproval(requestId: string) {
    const pending = this.pendingApprovals.get(requestId);
    if (pending) {
      pending.resolve({ action: 'cancel' });
      this.pendingApprovals.delete(requestId);
      this.broadcast({ type: 'approval_cleared', payload: { requestId } });
    }
  }

  sendNotification(message: string, style: 'info' | 'warning' | 'error' = 'info') {
    this.broadcast({
      type: 'notification',
      payload: { message, style }
    });
  }

  private broadcast(message: any) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        client.send(payload);
      }
    }
  }
}

export const controlPlane = new ControlPlane();
