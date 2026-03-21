# Folder System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add flat folders to organize question sets, with full CRUD and Browse page integration.

**Architecture:** New `Folder` Prisma model with unique name. `QuestionSet` gains optional `folderId` FK (SetNull on delete). Folder CRUD routes mounted at `/folders`. Browse page filters sets client-side by folder.

**Tech Stack:** Prisma (SQLite), Hono (API), React + React Query + Tailwind (frontend)

---

### Task 1: Prisma Schema — Add Folder model and QuestionSet.folderId

**Files:**
- Modify: `prisma/schema.prisma:10-19` (QuestionSet model)
- Modify: `prisma/schema.prisma` (add Folder model after BonusPart)

- [ ] **Step 1: Add Folder model to schema**

Add after the `BonusPart` model in `prisma/schema.prisma`:

```prisma
model Folder {
  id        String       @id @default(cuid())
  name      String       @unique
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
  sets      QuestionSet[]
}
```

- [ ] **Step 2: Add folderId to QuestionSet**

Add these fields to the `QuestionSet` model, after `updatedAt` and before `tossups`:

```prisma
  folderId   String?
  folder     Folder?  @relation(fields: [folderId], references: [id], onDelete: SetNull)
```

Add an index at the bottom of the QuestionSet model:

```prisma
  @@index([folderId])
```

- [ ] **Step 3: Generate migration and Prisma client**

Run: `npx prisma migrate dev --name add-folders`
Expected: Migration created, client regenerated, no errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/
git commit -m "feat: add Folder model and QuestionSet.folderId to schema"
```

---

### Task 2: API — Folder CRUD routes

**Files:**
- Create: `packages/api/src/routes/folders.ts`
- Modify: `packages/api/src/index.ts:28` (mount folder routes)

- [ ] **Step 1: Create folders route file**

Create `packages/api/src/routes/folders.ts`:

```typescript
import { createLogger, getDb } from "@3roads/shared";
import { Hono } from "hono";

const log = createLogger("api:folders");

export const foldersRoutes = new Hono();

// List all folders with set counts
foldersRoutes.get("/", async (c) => {
	log.info("GET /folders — request received");
	try {
		const db = getDb();
		const folders = await db.folder.findMany({
			orderBy: { name: "asc" },
			include: {
				_count: { select: { sets: true } },
			},
		});

		const result = folders.map(({ _count, ...rest }) => ({
			...rest,
			setCount: _count.sets,
		}));

		log.info(`GET /folders — returning ${result.length} folders`);
		return c.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error(`GET /folders — error: ${message}`);
		return c.json({ error: message }, 500);
	}
});

// Create folder
foldersRoutes.post("/", async (c) => {
	log.info("POST /folders — request received");
	try {
		const { name } = await c.req.json<{ name: string }>();
		const trimmed = name?.trim();
		if (!trimmed) {
			return c.json({ error: "name is required" }, 400);
		}

		const db = getDb();
		const folder = await db.folder.create({ data: { name: trimmed } });

		log.info(`POST /folders — created ${folder.id} "${folder.name}"`);
		return c.json(folder, 201);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("Unique constraint")) {
			return c.json({ error: "A folder with that name already exists" }, 409);
		}
		log.error(`POST /folders — error: ${message}`);
		return c.json({ error: message }, 500);
	}
});

// Rename folder
foldersRoutes.patch("/:id", async (c) => {
	const { id } = c.req.param();
	log.info(`PATCH /folders/${id} — request received`);
	try {
		const { name } = await c.req.json<{ name: string }>();
		const trimmed = name?.trim();
		if (!trimmed) {
			return c.json({ error: "name is required" }, 400);
		}

		const db = getDb();
		const folder = await db.folder.update({
			where: { id },
			data: { name: trimmed },
		});

		log.info(`PATCH /folders/${id} — renamed to "${folder.name}"`);
		return c.json(folder);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("P2025")) {
			return c.json({ error: "Folder not found" }, 404);
		}
		if (message.includes("Unique constraint")) {
			return c.json({ error: "A folder with that name already exists" }, 409);
		}
		log.error(`PATCH /folders/${id} — error: ${message}`);
		return c.json({ error: message }, 500);
	}
});

// Delete folder (sets become unfiled)
foldersRoutes.delete("/:id", async (c) => {
	const { id } = c.req.param();
	log.info(`DELETE /folders/${id} — request received`);
	try {
		const db = getDb();
		await db.folder.delete({ where: { id } });

		log.info(`DELETE /folders/${id} — deleted`);
		return c.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("P2025")) {
			return c.json({ error: "Folder not found" }, 404);
		}
		log.error(`DELETE /folders/${id} — error: ${message}`);
		return c.json({ error: message }, 500);
	}
});
```

- [ ] **Step 2: Mount folder routes in index.ts**

In `packages/api/src/index.ts`, add import and route mount:

```typescript
import { foldersRoutes } from "./routes/folders.js";
```

Add after the sets route mount (line 27):

```typescript
app.route("/folders", foldersRoutes);
```

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/folders.ts packages/api/src/index.ts
git commit -m "feat: add folder CRUD API routes"
```

---

### Task 3: API — Extend sets routes for folderId

**Files:**
- Modify: `packages/api/src/routes/sets.ts:9-36` (GET /sets — include folderId in response)
- Modify: `packages/api/src/routes/sets.ts:100-131` (PATCH /sets/:id — accept folderId)

- [ ] **Step 1: Update GET /sets to include folderId**

In the `findMany` call (line 13), the response already spreads all fields. Since `folderId` is a column on `QuestionSet`, it will be included automatically by Prisma. No change needed for the list endpoint.

Verify: check that `folderId` appears in the response by inspecting the Prisma-generated type.

- [ ] **Step 2: Update PATCH /sets/:id to accept folderId**

Replace the PATCH handler body (lines 104-130) in `packages/api/src/routes/sets.ts`:

```typescript
setsRoutes.patch("/:id", async (c) => {
	const { id } = c.req.param();
	log.info(`PATCH /sets/${id} — request received`);
	try {
		const body = await c.req.json<{ name?: string; theme?: string; folderId?: string | null }>();
		log.info(`PATCH /sets/${id} — params: name="${body.name}" theme="${body.theme}" folderId="${body.folderId}"`);
		const db = getDb();

		const data: Record<string, unknown> = {};
		if (body.name) data.name = body.name;
		if (body.theme) data.theme = body.theme;
		if ("folderId" in body) data.folderId = body.folderId ?? null;

		if (Object.keys(data).length === 0) {
			log.warn(`PATCH /sets/${id} — nothing to update`);
			return c.json({ error: "Nothing to update" }, 400);
		}

		const set = await db.questionSet.update({
			where: { id },
			data,
		});

		log.info(`PATCH /sets/${id} — updated`);
		return c.json(set);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`PATCH /sets/${id} — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});
```

Key change: `"folderId" in body` check (not truthiness) so `null` correctly unfiles a set. Type of `data` changed to `Record<string, unknown>` to allow `null`.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/sets.ts
git commit -m "feat: extend PATCH /sets/:id to accept folderId"
```

---

### Task 4: Frontend — useFolders hook

**Files:**
- Create: `packages/web/src/hooks/useFolders.ts`
- Modify: `packages/web/src/hooks/useSets.ts:5-16` (add folderId to QuestionSet type)

- [ ] **Step 1: Add folderId to QuestionSet interface**

In `packages/web/src/hooks/useSets.ts`, add `folderId` to the `QuestionSet` interface after `updatedAt`:

```typescript
  folderId: string | null;
```

- [ ] **Step 2: Create useFolders.ts**

Create `packages/web/src/hooks/useFolders.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPatch, apiDelete } from "../lib/api";

interface Folder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  setCount: number;
}

export type { Folder };

export function useFolders() {
  return useQuery({
    queryKey: ["folders"],
    queryFn: () => apiGet<Folder[]>("/folders"),
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiPost<Folder>("/folders", { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["folders"] }),
  });
}

export function useUpdateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiPatch<Folder>(`/folders/${id}`, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["sets"] });
    },
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/folders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["sets"] });
    },
  });
}
```

- [ ] **Step 3: Add useUpdateSet mutation to useSets.ts**

Add to the end of `packages/web/src/hooks/useSets.ts`:

```typescript
export function useUpdateSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; folderId?: string | null }) =>
      apiPatch<QuestionSet>(`/sets/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sets"] });
      qc.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}
```

- [ ] **Step 4: Add apiPatch import if missing**

In `packages/web/src/hooks/useSets.ts`, update the import on line 2:

```typescript
import { apiGet, apiDelete, apiPatch } from "../lib/api";
```

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/useFolders.ts packages/web/src/hooks/useSets.ts
git commit -m "feat: add useFolders hook and useUpdateSet for folder assignment"
```

---

### Task 5: Frontend — Browse page with folder navigation

**Files:**
- Modify: `packages/web/src/pages/Browse.tsx` (complete rewrite)

- [ ] **Step 1: Rewrite Browse.tsx with folder support**

Replace `packages/web/src/pages/Browse.tsx` with:

```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { useSets, useUpdateSet } from "../hooks/useSets";
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
    if (!trimmed) return;
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
                onKeyDown={(e) => e.key === "Enter" && handleRenameFolder(f.id)}
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
              <th className="py-1">name</th>
              <th className="py-1">difficulty</th>
              <th className="py-1">tossups</th>
              <th className="py-1">bonuses</th>
              <th className="py-1">folder</th>
              <th className="py-1">created</th>
            </tr>
          </thead>
          <tbody>
            {filteredSets.map((s) => (
              <tr key={s.id} className="border-b border-gray-300">
                <td className="py-1"><Link to={`/sets/${s.id}`} className="underline">{s.name}</Link></td>
                <td className="py-1">{s.difficulty}</td>
                <td className="py-1">{s.tossupCount ?? 0}</td>
                <td className="py-1">{s.bonusCount ?? 0}</td>
                <td className="py-1">
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

Key interactions:
- Filter bar: click folder to filter, double-click to rename, x to delete
- Inline form to create new folders
- Dropdown in each table row to move sets between folders
- "unfiled" filter for sets with no folder

- [ ] **Step 2: Verify the app builds**

Run: `cd packages/web && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/pages/Browse.tsx
git commit -m "feat: add folder navigation and management to Browse page"
```

---

### Task 6: Verify end-to-end

- [ ] **Step 1: Start the dev server and manually verify**

Run: `npm run dev` (or the project's dev command)

Test:
1. Browse page loads with folder bar showing "all" and "unfiled"
2. Create a folder via the input + "+" button
3. Folder appears in the bar with count (0)
4. Move a set into the folder via dropdown — folder count updates
5. Click folder to filter — only that folder's sets show
6. Click "unfiled" — only unfiled sets show
7. Double-click folder name to rename
8. Click "x" to delete folder — confirm dialog appears, sets become unfiled
9. Generate new questions — set appears as unfiled in Browse

- [ ] **Step 2: Final commit if any fixes needed**
