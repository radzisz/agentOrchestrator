import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { reloadInstances } from "@/lib/im-config";

export async function GET() {
  const instances = store.getIMProviderInstances();
  return NextResponse.json({ instances });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { type, name, config } = body;

  if (!type || !name) {
    return NextResponse.json({ error: "type and name are required" }, { status: 400 });
  }

  const instance: store.IMProviderInstance = {
    id: "",  // auto-assigned by saveIMProviderInstance
    type,
    name,
    isDefault: false,  // saveIMProviderInstance will set true if first
    enabled: true,
    config: config || {},
  };

  store.saveIMProviderInstance(instance);
  reloadInstances();

  return NextResponse.json(instance, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, name, type, config, isDefault, enabled } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getIMProviderInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  if (name !== undefined) existing.name = name;
  if (type !== undefined) existing.type = type;
  if (config !== undefined) existing.config = { ...existing.config, ...config };
  if (isDefault !== undefined) existing.isDefault = isDefault;
  if (enabled !== undefined) existing.enabled = enabled;

  store.saveIMProviderInstance(existing);
  reloadInstances();

  return NextResponse.json(existing);
}

export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getIMProviderInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  store.deleteIMProviderInstance(id);
  reloadInstances();

  return NextResponse.json({ ok: true });
}
