import { ChevronRight, GitMerge, GripVertical, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";

import { apiRequest } from "./api";
import { taxonomyRows, topicLabel } from "./topicTaxonomy";
import type { TopicNode } from "./types";

type FlatTopic = { id: number; name: string; parent_id: number | null; path: string };
type TopicData = { tree: TopicNode[]; flat: FlatTopic[] };
const euro = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

export default function TopicsPage() {
  const [data, setData] = useState<TopicData>({ tree: [], flat: [] });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [editName, setEditName] = useState("");
  const [editParent, setEditParent] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [confirmAction, setConfirmAction] = useState<"merge" | "delete" | null>(null);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | "root" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setData(await apiRequest<TopicData>("/api/topics"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load topics");
    }
  };

  useEffect(() => void load(), []);
  const selected = useMemo(() => data.flat.find((topic) => topic.id === selectedId), [data, selectedId]);
  const topicRows = useMemo(() => taxonomyRows(data.flat), [data.flat]);
  useEffect(() => {
    setEditName(selected?.name ?? "");
    setEditParent(selected?.parent_id?.toString() ?? "");
    setMergeTarget("");
    setConfirmAction(null);
  }, [selected]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const create = () => void run(async () => {
    await apiRequest("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, parent_id: newParent ? Number(newParent) : null }),
    });
    setNewName("");
    setNewParent("");
    await load();
  });

  const save = () => selected && void run(async () => {
    await apiRequest(`/api/topics/${selected.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName, parent_id: editParent ? Number(editParent) : null }),
    });
    await load();
  });

  const moveTopic = (topicId: number, parentId: number | null) => {
    const topic = data.flat.find((item) => item.id === topicId);
    if (!topic || topic.id === parentId || topic.parent_id === parentId) return;
    void run(async () => {
      await apiRequest(`/api/topics/${topic.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: topic.name, parent_id: parentId }),
      });
      await load();
    });
  };

  const drop = (event: DragEvent, parentId: number | null) => {
    event.preventDefault();
    event.stopPropagation();
    const topicId = Number(event.dataTransfer.getData("text/plain") || draggedId);
    setDraggedId(null);
    setDropTarget(null);
    if (topicId) moveTopic(topicId, parentId);
  };

  const merge = () => selected && mergeTarget && void run(async () => {
    await apiRequest(`/api/topics/${selected.id}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_id: Number(mergeTarget) }),
    });
    setSelectedId(null);
    await load();
  });

  const remove = () => selected && void run(async () => {
    await apiRequest(`/api/topics/${selected.id}`, { method: "DELETE" });
    setSelectedId(null);
    await load();
  });

  return (
    <div className="topics-page">
      {error && <div className="topic-error" onClick={() => setError("")}>{error}<span>×</span></div>}
      <section className="topic-create panel">
        <div><p className="eyebrow">BUILD YOUR TAXONOMY</p><h2>Add a topic</h2><span>Create it exactly as named under the selected parent.</span></div>
        <input aria-label="New topic name" placeholder="New topic name" value={newName} onChange={(event) => setNewName(event.target.value)} />
        <select aria-label="Parent topic" value={newParent} onChange={(event) => setNewParent(event.target.value)}><option value="">Root topic</option>{topicRows.map(({ topic, depth }) => <option key={topic.id} value={topic.id}>{topicLabel(topic.name, depth)}</option>)}</select>
        <button onClick={create} disabled={busy || !newName.trim()}>{busy ? <LoaderCircle className="spinner" /> : <Plus />}Add topic</button>
      </section>

      <div className="topics-layout">
        <section className="topic-tree panel">
          <div className="panel-heading"><div><p className="eyebrow">STRUCTURE</p><h2>Spending topics</h2></div><span>Drag topics to reorganize</span></div>
          <div className={dropTarget === "root" ? "topic-root-drop active" : "topic-root-drop"} onDragEnter={(event) => { event.preventDefault(); setDropTarget("root"); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => drop(event, null)}><GripVertical /><span><strong>Top level</strong><small>Drop here to remove a topic from its group</small></span></div>
          {data.tree.map((topic) => <TopicBranch key={topic.id} topic={topic} depth={0} selectedId={selectedId} draggedId={draggedId} dropTarget={dropTarget} busy={busy} onSelect={setSelectedId} onDragStart={(event, id) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(id)); setDraggedId(id); }} onDragEnd={() => { setDraggedId(null); setDropTarget(null); }} onDragEnter={(event, id) => { event.preventDefault(); event.stopPropagation(); if (id !== draggedId) setDropTarget(id); }} onDrop={drop} />)}
        </section>

        <aside className="topic-inspector panel">
          {selected ? <>
            <p className="eyebrow">EDIT TOPIC</p><h2>{selected.path}</h2>
            <label>Name<input value={editName} onChange={(event) => setEditName(event.target.value)} /></label>
            <label>Parent<select value={editParent} onChange={(event) => setEditParent(event.target.value)}><option value="">Root topic</option>{topicRows.filter(({ topic }) => topic.id !== selected.id).map(({ topic, depth }) => <option key={topic.id} value={topic.id}>{topicLabel(topic.name, depth)}</option>)}</select></label>
            <button className="primary-topic-action" onClick={save} disabled={busy || !editName.trim()}><Save />Save changes</button>
            <div className="topic-divider" />
            <label>Merge into<select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}><option value="">Choose destination</option>{topicRows.filter(({ topic }) => topic.id !== selected.id).map(({ topic, depth }) => <option key={topic.id} value={topic.id}>{topicLabel(topic.name, depth)}</option>)}</select></label>
            {confirmAction === "merge" ? <ConfirmRow label="Move its spending and children into the selected destination?" busy={busy} onCancel={() => setConfirmAction(null)} onConfirm={merge} /> : <button className="secondary-topic-action" disabled={!mergeTarget} onClick={() => setConfirmAction("merge")}><GitMerge />Merge topic</button>}
            {selected.parent_id !== null && (confirmAction === "delete" ? <ConfirmRow label="Move spending and children to its parent, then delete it?" busy={busy} onCancel={() => setConfirmAction(null)} onConfirm={remove} /> : <button className="danger-topic-action" onClick={() => setConfirmAction("delete")}><Trash2 />Delete topic</button>)}
          </> : <div className="topic-inspector-empty"><ChevronRight /><h2>Select a topic</h2><p>Rename, move, merge, or delete it here.</p></div>}
        </aside>
      </div>
    </div>
  );
}

function TopicBranch({ topic, depth, selectedId, draggedId, dropTarget, busy, onSelect, onDragStart, onDragEnd, onDragEnter, onDrop }: { topic: TopicNode; depth: number; selectedId: number | null; draggedId: number | null; dropTarget: number | "root" | null; busy: boolean; onSelect: (id: number) => void; onDragStart: (event: DragEvent, id: number) => void; onDragEnd: () => void; onDragEnter: (event: DragEvent, id: number) => void; onDrop: (event: DragEvent, parentId: number | null) => void }) {
  const className = ["topic-node-shell", draggedId === topic.id ? "dragging" : "", dropTarget === topic.id ? "drop-target" : ""].filter(Boolean).join(" ");
  return <div className="topic-branch"><div className={className} draggable={!busy} onDragStart={(event) => onDragStart(event, topic.id)} onDragEnd={onDragEnd} onDragEnter={(event) => onDragEnter(event, topic.id)} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => onDrop(event, topic.id)}><GripVertical className="topic-drag-handle" /><button className={selectedId === topic.id ? "topic-node selected" : "topic-node"} style={{ paddingLeft: 12 + depth * 25 }} onClick={() => onSelect(topic.id)}><i style={{ background: topic.color }} /><span><strong>{topic.name}</strong><small>{topic.transaction_count} transactions</small></span><em>{euro.format(topic.total_spend)}</em></button></div>{topic.children.map((child) => <TopicBranch key={child.id} topic={child} depth={depth + 1} selectedId={selectedId} draggedId={draggedId} dropTarget={dropTarget} busy={busy} onSelect={onSelect} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragEnter={onDragEnter} onDrop={onDrop} />)}</div>;
}

function ConfirmRow({ label, busy, onCancel, onConfirm }: { label: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="confirm-topic-action"><p>{label}</p><div><button onClick={onCancel}>Cancel</button><button onClick={onConfirm} disabled={busy}>Confirm</button></div></div>;
}
