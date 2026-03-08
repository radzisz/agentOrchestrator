import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { getAvailableTrackerTypes, resolveTrackerConfig } from "@/lib/issue-trackers/registry";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const schemas = getAvailableTrackerTypes();
  const trackerConfig = store.getProjectTrackerConfig(project.path);
  const entries = trackerConfig?.trackers || [];

  const result = entries.map((entry) => {
    const schema = schemas.find((s) => s.type === entry.type);
    const instance = entry.instanceId
      ? store.getTrackerInstance(entry.instanceId)
      : store.getDefaultTrackerInstance(entry.type);

    const resolved = resolveTrackerConfig(project.path, entry.type, entry.instanceId, entry.overrides);

    // Mask secrets in resolved config
    const maskedConfig = resolved ? { ...resolved } : null;
    if (maskedConfig && schema) {
      for (const field of schema.fields) {
        if (field.type === "secret" && maskedConfig[field.key]) {
          maskedConfig[field.key] = maskedConfig[field.key].slice(0, 4) + "...";
        }
      }
    }

    return {
      type: entry.type,
      displayName: schema?.displayName || entry.type,
      enabled: entry.enabled,
      instanceId: entry.instanceId || instance?.id,
      instanceName: instance?.name,
      overrides: entry.overrides,
      resolvedConfig: maskedConfig,
    };
  });

  return NextResponse.json({ trackers: result, schemas });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const project = store.getProjectByName(name);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = await req.json();
  const { trackers } = body as { trackers: store.ProjectTrackerEntry[] };

  if (!Array.isArray(trackers)) {
    return NextResponse.json({ error: "trackers array is required" }, { status: 400 });
  }

  store.saveProjectTrackerConfig(project.path, { trackers });

  return NextResponse.json({ ok: true });
}
