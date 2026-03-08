import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { getAvailableTrackerTypes } from "@/lib/issue-trackers/registry";

export async function GET() {
  const instances = store.getTrackerInstances();
  const schemas = getAvailableTrackerTypes();

  // Group by type
  const grouped: Record<string, store.TrackerInstance[]> = {};
  for (const inst of instances) {
    if (!grouped[inst.type]) grouped[inst.type] = [];
    grouped[inst.type].push(inst);
  }

  return NextResponse.json({ instances, grouped, schemas });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { type, name, config } = body;

  if (!type || !name) {
    return NextResponse.json({ error: "type and name are required" }, { status: 400 });
  }

  const instance: store.TrackerInstance = {
    id: "",  // auto-assigned by saveTrackerInstance
    type,
    name,
    isDefault: false,  // saveTrackerInstance will set true if first of type
    config: config || {},
  };

  store.saveTrackerInstance(instance);

  return NextResponse.json(instance, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, name, config, isDefault } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getTrackerInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  if (name !== undefined) existing.name = name;
  if (config !== undefined) existing.config = { ...existing.config, ...config };
  if (isDefault !== undefined) existing.isDefault = isDefault;

  store.saveTrackerInstance(existing);

  return NextResponse.json(existing);
}

export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getTrackerInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  store.deleteTrackerInstance(id);

  return NextResponse.json({ ok: true });
}
