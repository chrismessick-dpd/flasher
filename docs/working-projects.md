# Working and Released projects, edited and saved in Flasher

Status (2026-11-17): Chris agreed and said go. **Built, not committed:** steps 1 to 7 below. **Waiting:** step 8,
a first real save, at Chris's OK. For the two open questions, the build takes the doc's leanings: Save asks
which project, and an uploaded image takes an optional repo and commit, as Signoff FW releases do.

Where the build differs from the design below:
- **A system's own file is stored with the system** (`systems/<id>/<name>`, maybe in parts), not as an image in
  the project, so it needs no board entry.
- **Moving an image to a project in another repo moves its board,** with all the board's images, and the page
  says so first, because a board can live in only one repo. Within a repo, one image can move on its own.
- **A project not saved yet holds passthrough systems only.** Images and boards are added once it's saved (the
  project page says so), since they're written at once.
- **A system made outside a project** waits under *Unsorted* (not saved), and its Save asks which project.
- **Code:** `assets/image.js` (`cleanManifest`: `systems`, `kind: "file"`, a firmware's `project`, `edited`),
  `assets/access.js` (`edit`, `onlyTouched`, `saveProject`, `editFirmware`, `saveBoard`, `uploadImage`,
  `saveSystem`, `removeEntries`, `moveBoard`; sharing moves systems too), `assets/app.js` (*Working projects*),
  `tools/publish.py` (`keep_page_edits`), EE's `github.js` (`putFiles { head }`). Tests: EE 524, Flasher 83
  (6 new, against `tests/fakegithub.js`), Python 25.

Today a Flasher project only comes from `publish.py` (or `flasher.json` in a firmware repo), and a
passthrough system lives only in one browser. This makes Flasher's own projects editable and savable from
the page, and splits the sidebar into what's being worked on and what Signoff FW has released.

## Chris's answers (2026-11-17)

| Question | Answer |
| --- | --- |
| Where do projects live? | **Where they are.** `flasher_data` (FTEs) and one `review-flasher-<project>` repo per shared project. Nothing moves; the page can now write to them. |
| What's Released vs. Working? | **Released = Signoff FW.** Released Projects are FW targets and their releases. Working Projects are Flasher's own: published builds (the Arduino examples and the rest), saved systems, and new ones not saved yet. |
| Who edits an image's name and project? | **FTEs, into the manifest.** Saved with the same rules `publish.py` follows: read the head, change only what was edited, commit against that head, read back. |
| What can a project saved from Flasher hold? | **Passthrough systems, uploaded images, and board details.** |

## The sidebar

```
A file from this computer
WORKING PROJECTS                         [+ New project]   (FTEs)
  › Arduino Generator            10
  ⌄ Generator Firmware            3
      Display firmware           Generator display · 12.3 MB
      Generator firmware         Generator V2 · 214 KB
      Display through the V2     passthrough system
  ⌄ Bench rig  · Not saved        1      ← made here, kept in this browser until Save
      Display through the V2     passthrough system · Not saved
RELEASED PROJECTS
  ⌄ Smart Thermostat              (Signoff FW's project)
    ⌄ Thermostat Firmware         3
        0.9.1 · Draft
        0.9.0 · Released
        0.8.0 · Withdrawn
```

- **Working Projects** are the manifest's `projects`, each with its images (firmware entries) and its
  systems, plus projects made on this page and not saved yet. *New passthrough system* moves into a
  project's menu (⋯ › New passthrough system), and a system made outside any project lands in an unsaved
  *Unsorted* project, so nothing goes missing.
- **Released Projects** are Signoff FW's targets, grouped by the FW review's own project (`meta.project`),
  each target's releases under it, newest first. Read-only here: they're edited in Signoff FW. A system in
  a Working project can still point at one (the `fw-release` reference built today).
- Both keep the folding, the counts, the search, and the remembered open groups they have now.

## Editing an image (the circled area)

The About card's header gets two fields beside its title, FTEs only:

- **Name**: the firmware entry's `name`.
- **Project**: a pick of the Working projects, and *New project…*.

Edits wait in the card with **Save** and **Discard** (nothing is written until Save). Clients and contractors
see the name and project as text.

**A firmware's project.** Today a firmware entry's project comes from its board (`board.project`). An image
moved on its own gets its own `project` (a new optional field), which wins over its board's. Moving every
image of a board moves the board too.

**Moving an image to a project in another repo** (a shared project, or back to `flasher_data`) copies its
files there, checks each copy by git blob SHA, writes both manifests, and only then removes the originals,
the same order `FL.access.share` follows today.

## Saving a project

A project made on the page starts **Not saved**, kept in this browser (IndexedDB, like a system's file now),
with **Save** and **Discard** in its header. Once saved it has **Delete** instead.

| Action | What it writes |
| --- | --- |
| Save a new project | `projects[<id>] = { name }` in `flasher_data`'s manifest, and its systems, images, and boards, in one commit. |
| Save an edit | Only the entries that changed. |
| Discard | Nothing; the browser copy goes. |
| Delete a saved project | Asks first, listing what goes. Removes its manifest entries and its files in one commit. Git history keeps them. A project that's shared (its own `review-flasher-*` repo) can't be deleted until it's unshared on People & access. |
| Delete an image or a system | The same, for one entry. |

FTEs only: clients and contractors can't write `flasher_data`, and a shared project's repo is edited by FTEs
too, so the rule stays simple.

### What a saved project can hold

- **Images** uploaded from this computer: the `.bin`, `.hex`, or `.elf` as it is, in
  `firmware/<board>/<id>.<ext>`, split in parts over 4 MB as Signoff FW releases are. A new firmware kind,
  `"kind": "file"`, with `format` (bin, hex, or elf), `sha256`, and `parts`. A direct board flattens a `.hex`
  or `.elf` at its flash base (as a dropped file is today); a bridge board or a system splits it after INFO.
  `publish.py`'s kinds (`.bin`, `units`) are unchanged.
- **Systems**: a new manifest map, `systems[<id>] = { name, project, host, link, remote }`, the shape slice 1
  keeps in the browser now. The remote's firmware is a reference: an image in the project (`{ kind: 'image',
  id }`) or a Signoff FW release (`{ kind: 'fw-release', … }`). A system with a local file uploads that file
  as an image when it's saved. The bytes stay in the browser's IndexedDB as a cache.
- **Boards**: *Define a board* on the page writes a manifest board entry: name, MCU, flash and RAM, the USB
  ids it runs as, its DFU id, the restart rate, the BOOT0 steps, and notes, checked by the same
  `FL.image.cleanManifest` rules that check a published one. Bridge boards stay as they are; a page-made
  board behind a passthrough is a system, which needs no board entry.

### The write

Every save reads the repo's head and manifest, applies the edit to that manifest, and checks that nothing
but the edited entries changed. The manifest stays in `publish.py`'s layout (2-space JSON and a newline).
It commits on the head it read, then reads it back.

- **Engine change (EE `github.js`).** `putFiles` today retries a commit that lost a race on the newer head
  with the same files. For a manifest, that would quietly undo the other change. A new option,
  `putFiles(files, { head })`, commits only on that parent and fails with `code: 'moved'` instead of
  retrying. Flasher then re-reads and re-applies its edit, up to three times. Synced and vendored as usual.
  Nothing else changes for existing callers.
- **Ids.** A page-made project, image, system, or board gets a fresh id that can't collide with
  `publish.py`'s (they're slugs of names). Names are free text.

### publish.py keeps working beside it

`publish.py` stays the way to publish the Arduino examples and other built firmware. It needs three changes:

- Keep the new `systems` map, `kind: "file"` entries, and a firmware's own `project` when it writes.
- Its additive proof covers its own entries only, as now.
- A rebuild never changes a name or project an FTE edited on the page. A firmware entry gets
  `edited: { name, project }` stamps, and publish.py leaves a stamped field as it is.

## Access

Unchanged. Working projects follow Flasher's People & access (FTEs all, clients and contractors by shared
project). Released projects follow Signoff FW's sharing. Saving, moving, and deleting are for FTEs.

## The demo

The thermostat's Working project gains a saved system ("Display through the Main PCBA") and an uploaded
image. A *New project* made in the demo stays in the browser with Save and Discard, and Save there says that
the demo keeps everything in this browser. Released Projects shows the thermostat's three FW releases and the
display's passthrough release, as now.

## Build order (after Chris's go)

1. **Engine:** `putFiles` `head` option, with tests. Sync into ME and FW, and vendor everywhere.
2. **Flasher's manifest:** the `systems` map, `kind: "file"`, and a firmware's own `project` in
   `FL.image.cleanManifest`, plus a manifest editor (`FL.access.edit(repo, fn)`: read, apply, check, commit on
   the head, re-apply on `moved`, read back), with tests against `tests/fakegithub.js`.
3. **Sidebar:** Working Projects and Released Projects, with New project and the unsaved state.
4. **The About card's Name and Project,** with Save and Discard, including moves between repos.
5. **Saving systems, uploading images, and defining boards;** Delete.
6. **publish.py:** keep the new entries and the `edited` stamps, with Python tests.
7. **The demo and the docs** (README, CLAUDE.md).
8. **At Chris's OK,** a first real save: rename one image in `flasher_data`, shown as a dry run first.

## Open questions

- Should Unsorted (a system made outside any project) be a real project when saved, or should Save ask which
  project it goes in? The design above asks.
- Should a page-made image record where it came from (a typed repo and commit, as FW releases do), or just
  who uploaded it and when?
