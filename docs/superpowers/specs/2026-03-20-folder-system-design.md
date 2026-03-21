# Folder System for Sets

## Problem

Sets are flat and ungrouped. As the number of sets grows, users need a way to organize them into folders for easier browsing.

## Design

### Data Model

New `Folder` model in Prisma:

```prisma
model Folder {
  id        String       @id @default(cuid())
  name      String       @unique
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
  sets      QuestionSet[]
}
```

`QuestionSet` gets an optional folder reference:

```prisma
model QuestionSet {
  // ... existing fields
  folderId  String?
  folder    Folder?  @relation(fields: [folderId], references: [id], onDelete: SetNull)

  @@index([folderId])
}
```

- `folderId` is nullable. Sets without a folder are "unfiled."
- On folder delete, sets become unfiled (`SetNull`), not cascade deleted.
- No nesting — folders are flat.
- Folder names are unique (enforced at DB level).

### API Endpoints

**Folder CRUD:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/folders` | List all folders with set counts. Returns `{ id, name, createdAt, updatedAt, setCount }[]` |
| `POST` | `/folders` | Create folder. Body: `{ name }`. Name must be non-empty, trimmed. |
| `PATCH` | `/folders/:id` | Rename folder. Body: `{ name }`. Same validation. |
| `DELETE` | `/folders/:id` | Delete folder (sets become unfiled). Confirm in UI before calling. |

**Set endpoints updated:**

`GET /sets` response now includes `folderId` (string or null) on each set. Filtering by folder is done client-side since the set count will be small.

`PATCH /sets/:id` now also accepts `folderId` (string or `null` to unfile). Implementation must check `'folderId' in body` (not truthiness) since `null` is a valid value for unfiling.

### Browse Page UI

The Browse page gains folder-based navigation:

- **Folder list** at the top showing all folders with set counts
- **"All Sets"** view (default) shows everything
- **Clicking a folder** filters the table to that folder's sets (client-side)
- **"Unfiled"** filter shows sets with no folder
- **Folder management:** create, rename, delete folders inline. Delete shows confirm prompt.
- **Move sets:** dropdown on each set row to assign/change/remove folder

### Hooks

New React Query hooks in `useFolders.ts`:

- `useFolders()` — fetch all folders with counts. Returns `Folder[]` with `setCount`.
- `useCreateFolder()` — create folder, invalidate folders query
- `useUpdateFolder()` — rename folder, invalidate folders + sets queries (since sets embed folder info)
- `useDeleteFolder()` — delete folder, invalidate folders + sets queries

Existing `useSets` types updated: `QuestionSet` gains optional `folderId: string | null`. Both list and detail endpoints return this field.

### What's Not Included

- No nested folders
- No drag-and-drop (move via dropdown)
- No folder colors/icons
- No multi-select bulk move
