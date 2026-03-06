import { NextRequest, NextResponse } from "next/server";
import { eventBus } from "@/lib/event-bus";

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Linear webhook payload
  const { action, type, data } = body;

  if (type === "Comment" && action === "create") {
    // New comment on an issue — could be human feedback
    const issueId = data?.issue?.identifier;
    if (issueId) {
      eventBus.emit("incoming:message", {
        issueId,
        source: "linear",
        message: data.body || "",
        userId: data.user?.id,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
