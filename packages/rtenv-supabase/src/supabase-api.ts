const SB_API = "https://api.supabase.com/v1";

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export interface SBBranch {
  id: string;
  name: string;
  status: string;
  db_host?: string;
  ref?: string;
  error?: string;
}

export async function listBranches(token: string, projectRef: string): Promise<SBBranch[]> {
  const resp = await fetch(`${SB_API}/projects/${projectRef}/branches`, { headers: headers(token) });
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

export async function createBranch(token: string, projectRef: string, branchName: string, gitBranch?: string): Promise<SBBranch | null> {
  const resp = await fetch(`${SB_API}/projects/${projectRef}/branches`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ branch_name: branchName, git_branch: gitBranch || branchName }),
  });
  const data = await resp.json();
  return resp.ok && data.id ? data : null;
}

export async function getBranch(token: string, branchId: string): Promise<SBBranch | null> {
  const resp = await fetch(`${SB_API}/branches/${branchId}`, { headers: headers(token) });
  return resp.ok ? await resp.json() : null;
}

export async function deleteBranch(token: string, branchId: string): Promise<boolean> {
  const resp = await fetch(`${SB_API}/branches/${branchId}`, { method: "DELETE", headers: headers(token) });
  return resp.ok;
}
