import { NextResponse } from "next/server";
import { listAll } from "@/services/port-manager";

export async function GET() {
  const ports = listAll();
  return NextResponse.json(ports);
}
