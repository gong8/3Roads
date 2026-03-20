# Folder System for Sets

## Problem

Sets are flat and ungrouped. As the number of sets grows, users need a way to organize them into folders for easier browsing.

## Design

### Data Model

New `Folder` model in Prisma:

```prisma
model Folder {
  id        String       @id @default(cuid())
  name      String
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

### API Endpoints

**Folder CRUD:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/folders` | List all folders with set counts |
| `POST` | `/folders` | Create folder (`{ name }`) |
| `PATCH` | `/folders/:id` | Rename folder (`{ name }`) |
| `DELETE` | `/folders/:id` | Delete folder (sets become unfiled) |

**Set update (existing endpoint extended):**

`PATCH /sets/:id` now also accepts `folderId` (string or `null` to unfile).

### Browse Page UI

The Browse page gains folder-based navigation:

- **Folder sidebar/list** at the top or left showing all folders with set counts
- **"All Sets"** view (default) shows everything
- **Clicking a folder** filters the table to that folder's sets
- **"Unfiled"** filter shows sets with no folder
- **Folder management:** create, rename, delete folders inline
- **Move sets:** dropdown or action on each set row to assign/change folder

### Hooks

New React Query hooks in `useFolders.ts`:

- `useFolders()` — fetch all folders with counts
- `useCreateFolder()` — create folder, invalidate folders query
- `useUpdateFolder()` — rename folder, invalidate folders query
- `useDeleteFolder()` — delete folder, invalidate folders + sets queries

Existing `useSet` types updated to include optional `folderId`/`folder`.

### What's Not Included

- No nested folders
- No drag-and-drop (move via dropdown)
- No folder colors/icons
- No multi-select bulk move
