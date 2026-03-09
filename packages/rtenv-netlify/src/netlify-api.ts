const NF_API = "https://api.netlify.com/api/v1";

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export interface NFSite {
  id: string;
  name: string;
  account_id: string;
  ssl_url?: string;
  url?: string;
}

export interface NFDeploy {
  id: string;
  state: string;
  deploy_ssl_url?: string;
  error_message?: string;
}

export async function getSite(token: string, siteName: string): Promise<NFSite | null> {
  const resp = await fetch(`${NF_API}/sites/${siteName}.netlify.app`, { headers: headers(token) });
  return resp.ok ? await resp.json() : null;
}

export async function setEnvVar(
  token: string,
  accountId: string,
  key: string,
  value: string,
  branch: string,
): Promise<boolean> {
  const envVar = {
    key,
    scopes: ["builds", "functions"],
    values: [{ value, context: "branch-deploy", context_parameter: branch }],
  };

  // Try PATCH first, then POST if it doesn't exist
  const patchResp = await fetch(`${NF_API}/accounts/${accountId}/env/${key}`, {
    method: "PATCH",
    headers: headers(token),
    body: JSON.stringify({ scopes: envVar.scopes, values: envVar.values }),
  });
  if (patchResp.ok) return true;

  const postResp = await fetch(`${NF_API}/accounts/${accountId}/env`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify([envVar]),
  });
  return postResp.ok;
}

export async function triggerBuild(token: string, siteId: string, branch: string): Promise<{ deployId: string } | null> {
  const resp = await fetch(`${NF_API}/sites/${siteId}/builds`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ branch }),
  });
  const data = await resp.json();
  return resp.ok && data.deploy_id ? { deployId: data.deploy_id } : null;
}

export async function getDeploy(token: string, deployId: string): Promise<NFDeploy | null> {
  const resp = await fetch(`${NF_API}/deploys/${deployId}`, { headers: headers(token) });
  return resp.ok ? await resp.json() : null;
}
