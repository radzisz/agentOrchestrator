import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";

export async function GET() {
  const instances = store.getAIProviderInstances();
  return NextResponse.json({ instances });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { type, name, config } = body;

  if (!type || !name) {
    return NextResponse.json({ error: "type and name are required" }, { status: 400 });
  }

  const instance: store.AIProviderInstance = {
    id: "",  // auto-assigned by saveAIProviderInstance
    type,
    name,
    isDefault: false,  // saveAIProviderInstance will set true if first
    config: config || {},
  };

  store.saveAIProviderInstance(instance);

  return NextResponse.json(instance, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, name, type, config, isDefault } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getAIProviderInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  if (name !== undefined) existing.name = name;
  if (type !== undefined) existing.type = type;
  if (config !== undefined) existing.config = { ...existing.config, ...config };
  if (isDefault !== undefined) existing.isDefault = isDefault;

  store.saveAIProviderInstance(existing);

  return NextResponse.json(existing);
}

export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const existing = store.getAIProviderInstance(id);
  if (!existing) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  store.deleteAIProviderInstance(id);

  return NextResponse.json({ ok: true });
}
