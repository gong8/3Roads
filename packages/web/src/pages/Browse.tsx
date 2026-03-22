import { useState } from "react";
import { Link } from "react-router-dom";
import { useSets, useUpdateSet, useDeleteSet } from "../hooks/useSets";
import { useFolders, useCreateFolder, useUpdateFolder, useDeleteFolder } from "../hooks/useFolders";
import type { Folder } from "../hooks/useFolders";

type Filter = "all" | "unfiled" | string; // string = folder id

export function Browse() {
  const { data: sets, isLoading: setsLoading } = useSets();
  const { data: folders, isLoading: foldersLoading } = useFolders();
  const createFolder = useCreateFolder();
  const updateFolder = useUpdateFolder();
  const deleteFolder = useDeleteFolder();
  const updateSet = useUpdateSet();
  const deleteSet = useDeleteSet();

  const [filter, setFilter] = useState<Filter>("all");
  const [newFolderName, setNewFolderName] = useState("");
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  if (setsLoading || foldersLoading) return <p>loading...</p>;
  if (!sets?.length && !folders?.length) {
    return <p>no sets yet. <Link to="/generate" className="underline">generate some questions</Link></p>;
  }

  const filteredSets = sets?.filter((s) => {
    if (filter === "all") return true;
    if (filter === "unfiled") return !s.folderId;
    return s.folderId === filter;
  }) ?? [];

  const handleCreateFolder = () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    createFolder.mutate(trimmed);
    setNewFolderName("");
  };

  const handleRenameFolder = (id: string) => {
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditingFolder(null);
      return;
    }
    updateFolder.mutate({ id, name: trimmed });
    setEditingFolder(null);
  };

  const handleDeleteFolder = (folder: Folder) => {
    if (!confirm(`Delete folder "${folder.name}"? Sets inside will become unfiled.`)) return;
    deleteFolder.mutate(folder.id);
    if (filter === folder.id) setFilter("all");
  };

  const handleMoveSet = (setId: string, folderId: string | null) => {
    updateSet.mutate({ id: setId, folderId });
  };

  return (
    <div>
      {/* Folder bar */}
      <div className="mb-4 flex flex-wrap gap-2 items-center text-sm">
        <button
          onClick={() => setFilter("all")}
          className={`px-2 py-0.5 border ${filter === "all" ? "border-black font-bold" : "border-gray-300"}`}
        >
          all
        </button>
        <button
          onClick={() => setFilter("unfiled")}
          className={`px-2 py-0.5 border ${filter === "unfiled" ? "border-black font-bold" : "border-gray-300"}`}
        >
          unfiled
        </button>
        {folders?.map((f) => (
          <span key={f.id} className="inline-flex items-center gap-1">
            {editingFolder === f.id ? (
              <input
                className="border border-black px-1 w-28"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => handleRenameFolder(f.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRenameFolder(f.id);
                  if (e.key === "Escape") setEditingFolder(null);
                }}
                autoFocus
              />
            ) : (
              <button
                onClick={() => setFilter(f.id)}
                onDoubleClick={() => { setEditingFolder(f.id); setEditName(f.name); }}
                className={`px-2 py-0.5 border ${filter === f.id ? "border-black font-bold" : "border-gray-300"}`}
              >
                {f.name} ({f.setCount})
              </button>
            )}
            <button
              onClick={() => handleDeleteFolder(f)}
              className="text-gray-400 hover:text-black"
              title="delete folder"
            >
              x
            </button>
          </span>
        ))}
        <form onSubmit={(e) => { e.preventDefault(); handleCreateFolder(); }} className="inline-flex gap-1">
          <input
            className="border border-gray-300 px-1 w-28"
            placeholder="new folder"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
          />
          <button type="submit" className="border border-gray-300 px-1">+</button>
        </form>
      </div>

      {/* Sets table */}
      {filteredSets.length === 0 ? (
        <p className="text-sm text-gray-500">no sets in this view</p>
      ) : (
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-black">
              <th className="py-1 w-1/3">name</th>
              <th className="py-1">difficulty</th>
              <th className="py-1 text-center px-4">tossups</th>
              <th className="py-1 text-center px-4">bonuses</th>
              <th className="py-1 px-4">folder</th>
              <th className="py-1">created</th>
              <th className="py-1 w-16 text-center"></th>
            </tr>
          </thead>
          <tbody>
            {filteredSets.map((s) => (
              <tr key={s.id} className="border-b border-gray-300">
                <td className="py-1 break-words"><Link to={`/sets/${s.id}`} className="underline">{s.name}</Link></td>
                <td className="py-1">{s.difficulty}</td>
                <td className="py-1 text-center px-4">{s.tossupCount ?? 0}</td>
                <td className="py-1 text-center px-4">{(s.bonusCount ?? 0) > 0 ? "✓" : "✗"}</td>
                <td className="py-1 px-4">
                  <select
                    className="border border-gray-300 text-sm"
                    value={s.folderId ?? ""}
                    onChange={(e) => handleMoveSet(s.id, e.target.value || null)}
                  >
                    <option value="">—</option>
                    {folders?.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </td>
                <td className="py-1">{new Date(s.createdAt).toLocaleDateString()}</td>
                <td className="py-1 text-center">
                  <button
                    onClick={() => {
                      if (!confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
                      deleteSet.mutate(s.id);
                    }}
                    className="text-gray-400 hover:text-black text-xs cursor-pointer"
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
