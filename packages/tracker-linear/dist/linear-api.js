// ---------------------------------------------------------------------------
// Linear GraphQL client — pure API layer, no storage dependencies
// ---------------------------------------------------------------------------
const LINEAR_API_URL = "https://api.linear.app/graphql";
async function linearQuery(apiKey, query, variables) {
    var _a, _b;
    const response = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: {
            Authorization: apiKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
    });
    const json = await response.json();
    if (!response.ok || json.errors) {
        const msg = ((_b = (_a = json.errors) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.message) || response.statusText;
        throw new Error(`Linear API: ${msg}`);
    }
    return json.data;
}
const ISSUE_FIELDS = `
  id identifier title description priority url createdAt
  state { name }
  labels { nodes { id name } }
  creator { id name }
  assignee { id name }
  comments(first: 20, orderBy: createdAt) {
    nodes {
      body createdAt
      user { name isMe }
    }
  }
  attachments {
    nodes {
      id title url sourceType
    }
  }
  team { id key }
`;
export async function getAgentIssues(apiKey, teamId, label = "agent") {
    const data = await linearQuery(apiKey, `
    query($teamId: ID!, $label: String!) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          labels: { name: { eq: $label } }
        }
        first: 50
        orderBy: updatedAt
      ) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  `, { teamId, label });
    return data.issues.nodes;
}
export async function getIssue(apiKey, issueUuid) {
    var _a;
    const data = await linearQuery(apiKey, `
    query($id: String!) {
      issue(id: $id) {
        ${ISSUE_FIELDS}
      }
    }
  `, { id: issueUuid });
    return (_a = data.issue) !== null && _a !== void 0 ? _a : null;
}
export async function getAssignedIssues(apiKey, teamId, assigneeId) {
    const data = await linearQuery(apiKey, `
    query($teamId: ID!, $assigneeId: ID!) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          assignee: { id: { eq: $assigneeId } }
        }
        first: 50
        orderBy: updatedAt
      ) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  `, { teamId, assigneeId });
    return data.issues.nodes;
}
export async function getTeamMembers(apiKey, teamId) {
    const data = await linearQuery(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) {
        members {
          nodes { id name email displayName }
        }
      }
    }
  `, { teamId });
    return data.team.members.nodes;
}
export async function addComment(apiKey, issueUuid, body) {
    await linearQuery(apiKey, `
    mutation($id: String!, $body: String!) {
      commentCreate(input: { issueId: $id, body: $body }) {
        success
      }
    }
  `, { id: issueUuid, body });
}
export async function updateIssueState(apiKey, issueUuid, stateId) {
    await linearQuery(apiKey, `
    mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }
  `, { id: issueUuid, stateId });
}
export async function getWorkflowStateId(apiKey, teamKeyOrId, stateName) {
    var _a, _b;
    const isId = teamKeyOrId.includes("-");
    const filterField = isId ? "id" : "key";
    const data = await linearQuery(apiKey, `
    query($stateName: String!, $teamVal: String!) {
      workflowStates(
        filter: {
          name: { eq: $stateName }
          team: { ${filterField}: { eq: $teamVal } }
        }
      ) {
        nodes { id }
      }
    }
  `, { stateName, teamVal: teamKeyOrId });
    return (_b = (_a = data.workflowStates.nodes[0]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : null;
}
export async function listTeams(apiKey) {
    const data = await linearQuery(apiKey, `
    query {
      teams {
        nodes { id key name }
      }
    }
  `);
    return data.teams.nodes;
}
export async function resolveTeam(apiKey, teamKey) {
    const data = await linearQuery(apiKey, `
    query($teamKey: String!) {
      teams(filter: { key: { eq: $teamKey } }) {
        nodes {
          id name key
          organization { urlKey }
        }
      }
    }
  `, { teamKey });
    const team = data.teams.nodes[0];
    if (!team)
        return null;
    return {
        id: team.id,
        name: team.name,
        orgUrl: `https://linear.app/${team.organization.urlKey}/team/${team.key}`,
    };
}
export async function updateIssueAssignee(apiKey, issueUuid, assigneeId) {
    await linearQuery(apiKey, `
    mutation($id: String!, $assigneeId: String!) {
      issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
        success
      }
    }
  `, { id: issueUuid, assigneeId });
}
export async function listProjects(apiKey, teamId) {
    if (teamId) {
        const data = await linearQuery(apiKey, `
      query($teamId: String!) {
        team(id: $teamId) {
          projects {
            nodes { id name key state }
          }
        }
      }
    `, { teamId });
        return data.team.projects.nodes;
    }
    const data = await linearQuery(apiKey, `
    query {
      projects {
        nodes { id name key state }
      }
    }
  `);
    return data.projects.nodes;
}
export async function createIssue(apiKey, teamId, title, description, labelIds) {
    const data = await linearQuery(apiKey, `
    mutation($teamId: String!, $title: String!, $description: String!, $labelIds: [String!]) {
      issueCreate(input: { teamId: $teamId, title: $title, description: $description, labelIds: $labelIds }) {
        success
        issue { id identifier }
      }
    }
  `, { teamId, title, description, labelIds });
    return data.issueCreate.issue;
}
export async function getLabelId(apiKey, teamId, labelName) {
    var _a, _b;
    const data = await linearQuery(apiKey, `
    query($teamId: ID!, $labelName: String!) {
      issueLabels(
        filter: {
          name: { eq: $labelName }
          team: { id: { eq: $teamId } }
        }
      ) {
        nodes { id }
      }
    }
  `, { teamId, labelName });
    return (_b = (_a = data.issueLabels.nodes[0]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : null;
}
export async function removeLabel(apiKey, issueUuid, currentLabels, labelIdToRemove) {
    const remainingIds = currentLabels
        .filter((l) => l.id !== labelIdToRemove)
        .map((l) => l.id);
    await linearQuery(apiKey, `
    mutation($id: String!, $labelIds: [String!]!) {
      issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
    }
  `, { id: issueUuid, labelIds: remainingIds });
}
//# sourceMappingURL=linear-api.js.map