export interface LinearIssue {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    priority: number;
    url: string;
    state: {
        name: string;
    };
    labels: {
        nodes: Array<{
            id: string;
            name: string;
        }>;
    };
    creator: {
        id: string;
        name: string;
    } | null;
    comments: {
        nodes: Array<{
            body: string;
            createdAt: string;
            user: {
                name: string;
                isMe: boolean;
            };
        }>;
    };
    attachments: {
        nodes: Array<{
            id: string;
            title: string;
            url: string;
            sourceType?: string;
        }>;
    };
    createdAt: string;
    assignee: {
        id: string;
        name: string;
    } | null;
    team: {
        id: string;
        key: string;
    };
}
export declare function getAgentIssues(apiKey: string, teamId: string, label?: string): Promise<LinearIssue[]>;
export declare function getIssue(apiKey: string, issueUuid: string): Promise<LinearIssue | null>;
export declare function getAssignedIssues(apiKey: string, teamId: string, assigneeId: string): Promise<LinearIssue[]>;
export declare function getTeamMembers(apiKey: string, teamId: string): Promise<Array<{
    id: string;
    name: string;
    email: string;
    displayName: string;
}>>;
export declare function addComment(apiKey: string, issueUuid: string, body: string): Promise<void>;
export declare function updateIssueState(apiKey: string, issueUuid: string, stateId: string): Promise<void>;
export declare function getWorkflowStateId(apiKey: string, teamKeyOrId: string, stateName: string): Promise<string | null>;
export declare function listTeams(apiKey: string): Promise<Array<{
    id: string;
    key: string;
    name: string;
}>>;
export declare function resolveTeam(apiKey: string, teamKey: string): Promise<{
    id: string;
    name: string;
    orgUrl: string;
} | null>;
export declare function updateIssueAssignee(apiKey: string, issueUuid: string, assigneeId: string): Promise<void>;
export declare function listProjects(apiKey: string, teamId?: string): Promise<Array<{
    id: string;
    name: string;
    key: string;
    state: string;
}>>;
export declare function createIssue(apiKey: string, teamId: string, title: string, description: string, labelIds: string[]): Promise<{
    id: string;
    identifier: string;
}>;
export declare function getLabelId(apiKey: string, teamId: string, labelName: string): Promise<string | null>;
export declare function removeLabel(apiKey: string, issueUuid: string, currentLabels: Array<{
    id: string;
    name: string;
}>, labelIdToRemove: string): Promise<void>;
//# sourceMappingURL=linear-api.d.ts.map