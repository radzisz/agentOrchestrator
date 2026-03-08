import * as store from "@/lib/store";
import { redirect, notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AgentRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  for (const project of store.listProjects()) {
    const found = store.getAgent(project.path, id);
    if (found) {
      redirect(`/projects/${project.name}/agents/${id}`);
    }
  }

  notFound();
}
