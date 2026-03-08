import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";

export async function GET() {
  const instances = store.getRepoProviderInstances();
  return NextResponse.json({ instances });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { type, name, config } = body;

  if (!type || !name) {
    return NextResponse.json({ error: "type and name are required" }, { status: 400 });
  }

  const instance: store.RepoProviderInstance = {
    id: "",  // auto-assigned by saveRepoProviderInstance
    type,
    name,
    isDefault: false,  // saveRepoProviderInstance will set true if first
    config: config || {},
  };

  store.saveRepoProviderInstance(instance);

  return NextResponse.json(instance, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, name, type, config, isDefault } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getRepoProviderInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  if (name !== undefined) existing.name = name;
  if (type !== undefined) existing.type = type;
  if (config !== undefined) existing.config = { ...existing.config, ...config };
  if (isDefault !== undefined) existing.isDefault = isDefault;

  store.saveRepoProviderInstance(existing);

  return NextResponse.json(existing);
}

export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getRepoProviderInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  store.deleteRepoProviderInstance(id);

  return NextResponse.json({ ok: true });
}
