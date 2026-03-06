import { NextRequest, NextResponse } from "next/server";
import { eventBus } from "@/lib/event-bus";

export async function POST(req: NextRequest) {
  const body = await req.json();

  const message = body.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const text = message.text;
  const threadId = message.message_thread_id;
  const userId = message.from?.id?.toString();

  // Skip bot messages
  if (message.from?.is_bot) {
    return NextResponse.json({ ok: true });
  }

  // Try to resolve issue from thread_id via extension config
  // For now, emit as generic incoming message
  eventBus.emit("incoming:message", {
    issueId: `thread:${threadId}`,
    source: "telegram",
    message: text,
    userId,
  });

  return NextResponse.json({ ok: true });
}
