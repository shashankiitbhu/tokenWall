import { FastifyInstance } from 'fastify';
export interface ApprovalRequest {
    requestId: string;
    projectId: string | null;
    sessionId: string;
    model: string;
    estimatedCost: number;
    warnings: any[];
}
export declare class ControlPlane {
    private clients;
    private pendingApprovals;
    registerWebsocket(fastify: FastifyInstance): void;
    requestApproval(request: ApprovalRequest): Promise<'approve' | 'optimize' | 'switch_model' | 'cancel'>;
    private broadcast;
}
export declare const controlPlane: ControlPlane;
