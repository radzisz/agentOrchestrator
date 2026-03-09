const V_API = "https://api.vercel.com";

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export interface VDeployment {
  id: string;
  uid: string;
  name: string;
  url: string;
  state: string;        // QUEUED | BUILDING | READY | ERROR | CANCELED
  readyState?: string;
  error?: { message: string };
}

export async function listDeployments(
  token: string,
  projectId: string,
  opts?: { teamId?: string; limit?: number },
): Promise<VDeployment[]> {
  const params = new URLSearchParams({ projectId, limit: String(opts?.limit || 10) });
  if (opts?.teamId) params.set("teamId", opts.teamId);
  const resp = await fetch(`${V_API}/v6/deployments?${params}`, { headers: headers(token) });
  const data = await resp.json();
  return data.deployments || [];
}

export async function createDeployment(
  token: string,
  projectName: string,
  gitBranch: string,
  opts?: { teamId?: string },
): Promise<VDeployment | null> {
  const params = opts?.teamId ? `?teamId=${opts.teamId}` : "";
  const resp = await fetch(`${V_API}/v13/deployments${params}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      name: projectName,
      gitSource: { type: "github", ref: gitBranch },
      target: "preview",
    }),
  });
  const data = await resp.json();
  return resp.ok ? data : null;
}

export async function getDeployment(token: string, deploymentId: string, teamId?: string): Promise<VDeployment | null> {
  const params = teamId ? `?teamId=${teamId}` : "";
  const resp = await fetch(`${V_API}/v13/deployments/${deploymentId}${params}`, { headers: headers(token) });
  return resp.ok ? await resp.json() : null;
}

export async function cancelDeployment(token: string, deploymentId: string, teamId?: string): Promise<boolean> {
  const params = teamId ? `?teamId=${teamId}` : "";
  const resp = await fetch(`${V_API}/v13/deployments/${deploymentId}/cancel${params}`, {
    method: "PATCH",
    headers: headers(token),
  });
  return resp.ok;
}

export async function setEnvVar(
  token: string,
  projectId: string,
  key: string,
  value: string,
  target: string[],
  gitBranch?: string,
  teamId?: string,
): Promise<boolean> {
  const params = teamId ? `?teamId=${teamId}` : "";
  const body: Record<string, unknown> = { key, value, type: "plain", target };
  if (gitBranch) body.gitBranch = gitBranch;
  const resp = await fetch(`${V_API}/v10/projects/${projectId}/env${params}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
  });
  return resp.ok;
}
