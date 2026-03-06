/**
 * Linear GraphQL client — replaces curl calls to Linear API
 */

const LINEAR_API_URL = "https://api.linear.app/graphql";

async function linearQuery<T = any>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
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
    const msg = json.errors?.[0]?.message || response.statusText;
    throw new Error(`Linear API: ${msg}`);
  }

  return json.data;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
  comments: {
    nodes: Array<{
      body: string;
      createdAt: string;
      user: { name: string; isMe: boolean };
    }>;
  };
  team: { id: string; key: string };
}

export async function getAgentIssues(
  apiKey: string,
  teamId: string,
  label: string = "agent"
): Promise<LinearIssue[]> {
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
        nodes {
          id identifier title description priority
          state { name }
          labels { nodes { name } }
          comments(first: 20, orderBy: createdAt) {
            nodes {
              body createdAt
              user { name isMe }
            }
          }
          team { id key }
        }
      }
    }
  `, { teamId, label });

  return data.issues.nodes;
}

export async function getIssue(
  apiKey: string,
  issueUuid: string
): Promise<LinearIssue | null> {
  const data = await linearQuery(apiKey, `
    query($id: String!) {
      issue(id: $id) {
        id identifier title description priority
        state { name }
        labels { nodes { name } }
        comments(first: 20, orderBy: createdAt) {
          nodes {
            body createdAt
            user { name isMe }
          }
        }
        team { id key }
      }
    }
  `, { id: issueUuid });

  return data.issue ?? null;
}

export async function createIssue(
  apiKey: string,
  teamId: string,
  title: string,
  description: string,
  labelIds: string[]
): Promise<{ id: string; identifier: string }> {
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

export async function getLabelId(
  apiKey: string,
  teamId: string,
  labelName: string
): Promise<string | null> {
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

  return data.issueLabels.nodes[0]?.id ?? null;
}

export async function addComment(
  apiKey: string,
  issueUuid: string,
  body: string
): Promise<void> {
  await linearQuery(apiKey, `
    mutation($id: String!, $body: String!) {
      commentCreate(input: { issueId: $id, body: $body }) {
        success
      }
    }
  `, { id: issueUuid, body });
}

export async function updateIssueState(
  apiKey: string,
  issueUuid: string,
  stateId: string
): Promise<void> {
  await linearQuery(apiKey, `
    mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }
  `, { id: issueUuid, stateId });
}

export async function getWorkflowStateId(
  apiKey: string,
  teamKey: string,
  stateName: string
): Promise<string | null> {
  const data = await linearQuery(apiKey, `
    query($stateName: String!, $teamKey: String!) {
      workflowStates(
        filter: {
          name: { eq: $stateName }
          team: { key: { eq: $teamKey } }
        }
      ) {
        nodes { id }
      }
    }
  `, { stateName, teamKey });

  return data.workflowStates.nodes[0]?.id ?? null;
}

export async function resolveTeam(
  apiKey: string,
  teamKey: string
): Promise<{ id: string; name: string; orgUrl: string } | null> {
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
  if (!team) return null;

  return {
    id: team.id,
    name: team.name,
    orgUrl: `https://linear.app/${team.organization.urlKey}/team/${team.key}`,
  };
}
