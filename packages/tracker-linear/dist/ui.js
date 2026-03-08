"use client";
import { useState, useEffect } from "react";
import { OverrideField, TrashIcon } from "@orchestrator/ui";
export function LinearProjectConfigPanel({ overrideFields, overrides, resolvedConfig, projectName, setField, }) {
    const [teams, setTeams] = useState([]);
    const [loadingTeams, setLoadingTeams] = useState(false);
    const [members, setMembers] = useState([]);
    const [loadingMembers, setLoadingMembers] = useState(false);
    const [linearProjects, setLinearProjects] = useState([]);
    const [loadingProjects, setLoadingProjects] = useState(false);
    const detectionMode = overrides.detectionMode || resolvedConfig.detectionMode || "label";
    const currentTeamId = overrides.teamId || resolvedConfig.teamId || "";
    const selectedProjectIds = (overrides.projectIds || resolvedConfig.projectIds || "")
        .split(",")
        .filter(Boolean);
    // Fetch Linear teams
    useEffect(() => {
        setLoadingTeams(true);
        fetch(`/api/projects/${projectName}/linear/teams`)
            .then((r) => r.ok ? r.json() : [])
            .then((data) => setTeams(Array.isArray(data) ? data : []))
            .catch(() => { })
            .finally(() => setLoadingTeams(false));
    }, [projectName]);
    // Fetch Linear team members when assignee mode is active
    useEffect(() => {
        if (detectionMode !== "assignee")
            return;
        if (members.length > 0)
            return;
        setLoadingMembers(true);
        fetch(`/api/projects/${projectName}/linear/members`)
            .then((r) => r.ok ? r.json() : [])
            .then((data) => setMembers(Array.isArray(data) ? data : []))
            .catch(() => { })
            .finally(() => setLoadingMembers(false));
    }, [detectionMode, projectName, members.length]);
    // Fetch Linear projects
    useEffect(() => {
        setLoadingProjects(true);
        fetch(`/api/projects/${projectName}/linear/projects`)
            .then((r) => r.ok ? r.json() : [])
            .then((data) => setLinearProjects(Array.isArray(data) ? data : []))
            .catch(() => { })
            .finally(() => setLoadingProjects(false));
    }, [projectName]);
    // Fields we handle manually — skip in generic loop
    const manualKeys = new Set(["detectionMode", "label", "assigneeId", "assigneeName", "reassignOnDone", "teamId", "teamKey", "projectIds"]);
    const genericFields = overrideFields.filter((f) => !manualKeys.has(f.key));
    return (<div className="space-y-3">
      <label className="text-xs text-muted-foreground block font-medium">Project settings</label>

      {/* Team picker */}
      <div>
        <label className="text-xs text-muted-foreground block mb-1">
          Team <span className="text-red-500">*</span>
        </label>
        {loadingTeams ? (<p className="text-xs text-muted-foreground">Loading teams...</p>) : teams.length > 0 ? (<select className="w-full px-2 py-1 text-sm border rounded bg-background" value={currentTeamId} onChange={(e) => {
                const team = teams.find((t) => t.id === e.target.value);
                setField("teamId", e.target.value);
                setField("teamKey", (team === null || team === void 0 ? void 0 : team.key) || "");
            }}>
            <option value="">Select team...</option>
            {teams.map((t) => (<option key={t.id} value={t.id}>
                {t.key} — {t.name}
              </option>))}
          </select>) : (<input className="w-full px-2 py-1 text-sm border rounded bg-background" value={overrides.teamId || ""} onChange={(e) => setField("teamId", e.target.value)} placeholder="Team ID (could not load teams)"/>)}
      </div>

      {/* Generic fields (previewLabel etc.) */}
      {genericFields.map((field) => (<OverrideField key={field.key} field={field} value={overrides[field.key] || ""} onChange={(value) => setField(field.key, value)}/>))}

      {/* Detection Mode as radio buttons */}
      <div>
        <label className="text-xs text-muted-foreground block mb-2">Detection Mode</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="detectionMode" checked={detectionMode === "label"} onChange={() => {
            setField("detectionMode", "label");
            setField("assigneeId", "");
            setField("assigneeName", "");
        }} className="accent-primary"/>
            <span className="text-sm">By Label</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="detectionMode" checked={detectionMode === "assignee"} onChange={() => setField("detectionMode", "assignee")} className="accent-primary"/>
            <span className="text-sm">By Assignee</span>
          </label>
        </div>
      </div>

      {/* Label field — visible when mode = label */}
      {detectionMode === "label" && (<OverrideField field={{ key: "label", label: "Detection Label", type: "string", default: "agent", description: "Label to detect agent issues" }} value={overrides.label || ""} onChange={(value) => setField("label", value)}/>)}

      {/* Assignee picker — visible when mode = assignee */}
      {detectionMode === "assignee" && (<div>
          <label className="text-xs text-muted-foreground block mb-1">Assignee</label>
          {loadingMembers ? (<p className="text-xs text-muted-foreground">Loading team members...</p>) : members.length > 0 ? (<select className="w-full px-2 py-1 text-sm border rounded bg-background" value={overrides.assigneeId || resolvedConfig.assigneeId || ""} onChange={(e) => {
                    const member = members.find((m) => m.id === e.target.value);
                    setField("assigneeId", e.target.value);
                    setField("assigneeName", (member === null || member === void 0 ? void 0 : member.displayName) || (member === null || member === void 0 ? void 0 : member.name) || "");
                }}>
              <option value="">Select team member...</option>
              {members.map((m) => (<option key={m.id} value={m.id}>
                  {m.displayName || m.name} ({m.email})
                </option>))}
            </select>) : (<input className="w-full px-2 py-1 text-sm border rounded bg-background" value={overrides.assigneeId || ""} onChange={(e) => setField("assigneeId", e.target.value)} placeholder="Assignee ID (could not load members)"/>)}
          {overrides.assigneeName && (<p className="text-[11px] text-muted-foreground mt-1">Selected: {overrides.assigneeName}</p>)}

          {/* Reassign on done */}
          <div className="mt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={(overrides.reassignOnDone || resolvedConfig.reassignOnDone || "true") === "true"} onChange={(e) => setField("reassignOnDone", e.target.checked ? "true" : "false")} className="accent-primary"/>
              <span className="text-sm">Reassign to creator when done</span>
            </label>
          </div>
        </div>)}

      {/* Projects section */}
      <div>
        <label className="text-xs text-muted-foreground block mb-2">Projects</label>
        {loadingProjects ? (<p className="text-xs text-muted-foreground">Loading projects...</p>) : linearProjects.length > 0 ? (<div className="space-y-2">
            {/* Selected projects */}
            {selectedProjectIds.length > 0 && (<div className="space-y-1">
                {selectedProjectIds.map((pid) => {
                    const proj = linearProjects.find((p) => p.id === pid);
                    return (<div key={pid} className="flex items-center gap-2 text-sm bg-muted/30 rounded px-2 py-1">
                      <span className="flex-1 font-mono text-xs">
                        {proj ? `${proj.key} — ${proj.name}` : pid}
                      </span>
                      <button className="text-muted-foreground hover:text-destructive" onClick={() => {
                            const updated = selectedProjectIds.filter((id) => id !== pid);
                            setField("projectIds", updated.join(","));
                        }}>
                        <TrashIcon className="h-3 w-3"/>
                      </button>
                    </div>);
                })}
              </div>)}

            {/* Add project dropdown */}
            {(() => {
                const available = linearProjects.filter((p) => !selectedProjectIds.includes(p.id));
                if (available.length === 0)
                    return null;
                return (<select className="w-full px-2 py-1 text-sm border rounded bg-background" value="" onChange={(e) => {
                        if (!e.target.value)
                            return;
                        const updated = [...selectedProjectIds, e.target.value];
                        setField("projectIds", updated.join(","));
                    }}>
                  <option value="">Add project...</option>
                  {available.map((p) => (<option key={p.id} value={p.id}>
                      {p.key} — {p.name} ({p.state})
                    </option>))}
                </select>);
            })()}

            {selectedProjectIds.length === 0 && (<p className="text-[11px] text-muted-foreground">No projects selected — all issues will be tracked</p>)}
          </div>) : (<p className="text-xs text-muted-foreground">No Linear projects found</p>)}
      </div>
    </div>);
}
//# sourceMappingURL=ui.js.map