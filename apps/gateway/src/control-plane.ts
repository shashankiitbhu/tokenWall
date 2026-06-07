import { FastifyInstance } from 'fastify';


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
              pending.resolve({ action, chosenModel });
              this.pendingApprovals.delete(requestId);
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
    return new Promise((resolve) => {
      this.pendingApprovals.set(request.requestId, { request, resolve });
      this.broadcast({
        type: 'approval_pending',
        payload: request
      });
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
