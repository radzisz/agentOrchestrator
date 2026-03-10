"use client";

import { useEffect, useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";

interface AIRule {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  order: number;
  whenToUse: string;
}

export default function AIRulesPage() {
  const [rules, setRules] = useState<AIRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);
  const [formWhenToUse, setFormWhenToUse] = useState("");
  const saveCounter = useRef(0);

  useEffect(() => {
    fetch("/api/ai-rules")
      .then((r) => r.json())
      .then((data) => setRules(data.rules || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function persist(next: AIRule[]) {
    saveCounter.current++;
    const snap = saveCounter.current;
    setTimeout(() => {
      if (snap !== saveCounter.current) return;
      fetch("/api/ai-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: next }),
      }).then((r) => {
        if (r.ok) toast.success("Rules saved");
        else toast.error("Failed to save rules");
      }).catch(() => toast.error("Failed to save rules"));
    }, 500);
  }

  function updateRules(updater: (prev: AIRule[]) => AIRule[]) {
    setRules((prev) => {
      const next = updater(prev);
      persist(next);
      return next;
    });
  }

  function resetForm() {
    setShowForm(false);
    setEditingId(null);
    setFormTitle("");
    setFormContent("");
    setFormEnabled(true);
    setFormWhenToUse("");
  }

  function handleSaveRule() {
    if (!formTitle.trim()) return;
    const nextOrder = rules.length > 0 ? Math.max(...rules.map((r) => r.order)) + 1 : 0;

    if (editingId) {
      updateRules((prev) => prev.map((r) =>
        r.id === editingId ? { ...r, title: formTitle, content: formContent, enabled: formEnabled, whenToUse: formWhenToUse } : r
      ));
    } else {
      updateRules((prev) => [...prev, {
        id: crypto.randomUUID(),
        title: formTitle,
        content: formContent,
        enabled: formEnabled,
        order: nextOrder,
        whenToUse: formWhenToUse,
      }]);
    }
    resetForm();
  }

  function handleStartEdit(rule: AIRule) {
    setEditingId(rule.id);
    setFormTitle(rule.title);
    setFormContent(rule.content);
    setFormEnabled(rule.enabled);
    setFormWhenToUse(rule.whenToUse);
    setShowForm(true);
  }

  function handleMove(id: string, dir: -1 | 1) {
    const sorted = [...rules].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((r) => r.id === id);
    const target = idx + dir;
    if (target < 0 || target >= sorted.length) return;
    const tmpOrder = sorted[idx].order;
    sorted[idx] = { ...sorted[idx], order: sorted[target].order };
    sorted[target] = { ...sorted[target], order: tmpOrder };
    updateRules(() => sorted);
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Loading rules...</p>
      </div>
    );
  }

  const sorted = [...rules].sort((a, b) => a.order - b.order);
  const activeCount = rules.filter((r) => r.enabled).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 bg-background px-6 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">AI Rules</h1>
          <p className="text-sm text-muted-foreground">
            Global rules injected into agent context. Agent decides which to apply based on task and codebase.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{activeCount} active / {rules.length} total</span>
      </div>

      <div className="p-6 space-y-4 max-w-3xl">
        {sorted.map((rule, idx) => (
          <Card key={rule.id} className="bg-muted/20">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="flex flex-col gap-0.5 mt-1">
                  <button
                    className="text-muted-foreground hover:text-foreground disabled:opacity-20 p-0"
                    disabled={idx === 0}
                    onClick={() => handleMove(rule.id, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="text-muted-foreground hover:text-foreground disabled:opacity-20 p-0"
                    disabled={idx === sorted.length - 1}
                    onClick={() => handleMove(rule.id, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium ${rule.enabled ? "" : "text-muted-foreground line-through"}`}>
                      {rule.title}
                    </span>
                  </div>
                  {rule.whenToUse && (
                    <p className="text-sm text-blue-500 mt-1">{rule.whenToUse}</p>
                  )}
                  <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap line-clamp-4">{rule.content}</p>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rule.enabled}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${rule.enabled ? "bg-primary" : "bg-muted"}`}
                    onClick={() => updateRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))}
                  >
                    <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${rule.enabled ? "translate-x-4" : "translate-x-0"}`} />
                  </button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleStartEdit(rule)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => updateRules((prev) => prev.filter((r) => r.id !== rule.id))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {sorted.length === 0 && !showForm && (
          <div className="text-center py-12 text-muted-foreground">
            <p className="text-lg mb-2">No rules yet</p>
            <p className="text-sm">Add rules that will be injected into agent context. The agent will decide which apply.</p>
          </div>
        )}

        {showForm ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{editingId ? "Edit Rule" : "New Rule"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Title</label>
                <input
                  className="w-full px-3 py-2 text-sm border rounded bg-background"
                  placeholder="e.g. React conventions"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">When to use</label>
                <input
                  className="w-full px-3 py-2 text-sm border rounded bg-background"
                  placeholder="e.g. When task involves React frontend components"
                  value={formWhenToUse}
                  onChange={(e) => setFormWhenToUse(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  The agent reads this and decides whether to apply the rule based on the task and codebase.
                </p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Content</label>
                <textarea
                  className="w-full px-3 py-2 text-sm border rounded bg-background min-h-[120px] font-mono"
                  placeholder="Rule content (Markdown) — instructions the agent should follow"
                  value={formContent}
                  onChange={(e) => setFormContent(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveRule} disabled={!formTitle.trim()}>
                  {editingId ? "Update Rule" : "Add Rule"}
                </Button>
                <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4 mr-2" /> Add Rule
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
