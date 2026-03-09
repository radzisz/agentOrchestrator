import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";

// Available rtenv type schemas
const SCHEMAS = [
  {
    type: "supabase",
    displayName: "Supabase",
    fields: [
      { key: "accessToken", label: "Access Token", type: "secret", required: true, description: "Supabase Personal Access Token (sbp_...)" },
    ],
    projectFields: [
      { key: "projectRef", label: "Project Ref", type: "string", required: true, description: "Supabase project reference ID" },
    ],
  },
  {
    type: "netlify",
    displayName: "Netlify",
    fields: [
      { key: "authToken", label: "Auth Token", type: "secret", required: true, description: "Netlify Personal Access Token (nfp_...)" },
    ],
    projectFields: [
      {
        key: "sites", label: "Sites", type: "list", required: true,
        description: "Netlify sites to deploy",
        columns: [
          { key: "name", label: "Service", placeholder: "e.g. guide" },
          { key: "siteName", label: "Site Name", placeholder: "e.g. myapp-guide" },
          { key: "domain", label: "Domain", placeholder: "e.g. *.example.com" },
        ],
      },
    ],
  },
  {
    type: "vercel",
    displayName: "Vercel",
    fields: [
      { key: "authToken", label: "Auth Token", type: "secret", required: true, description: "Vercel Personal Access Token" },
      { key: "teamId", label: "Team ID", type: "string", description: "Optional team/org ID" },
    ],
    projectFields: [
      {
        key: "projects", label: "Projects", type: "list", required: true,
        description: "Vercel projects to deploy",
        columns: [
          { key: "name", label: "Service", placeholder: "e.g. web" },
          { key: "projectName", label: "Project Name", placeholder: "e.g. myapp-web" },
          { key: "domain", label: "Domain", placeholder: "e.g. *.example.com" },
        ],
      },
    ],
  },
];

export async function GET() {
  const instances = store.getRtenvInstances();
  return NextResponse.json({ instances, schemas: SCHEMAS });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { type, name, config } = body;

  if (!type || !name) {
    return NextResponse.json({ error: "type and name are required" }, { status: 400 });
  }

  const instance: store.RuntimeEnvInstance = {
    id: "",
    type,
    name,
    enabled: true,
    config: config || {},
  };

  store.saveRtenvInstance(instance);
  return NextResponse.json(instance, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, name, type, config, enabled } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getRtenvInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  if (name !== undefined) existing.name = name;
  if (type !== undefined) existing.type = type;
  if (config !== undefined) existing.config = { ...existing.config, ...config };
  if (enabled !== undefined) existing.enabled = enabled;

  store.saveRtenvInstance(existing);
  return NextResponse.json(existing);
}

export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getRtenvInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  store.deleteRtenvInstance(id);
  return NextResponse.json({ ok: true });
}
