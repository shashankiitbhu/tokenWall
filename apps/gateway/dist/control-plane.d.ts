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
export declare class ControlPlane {
    private clients;
    private pendingApprovals;
    registerWebsocket(fastify: FastifyInstance): void;
    requestApproval(request: ApprovalRequest): Promise<{
        action: 'approve' | 'optimize' | 'switch_model' | 'cancel';
        chosenModel?: string;
    }>;
    sendNotification(message: string, style?: 'info' | 'warning' | 'error'): void;
    private broadcast;
}
export declare const controlPlane: ControlPlane;
