# Features

A short guide to what DeepLabel does and how to use it. The [README](../README.md) has the
overview and setup.

## Contents

- [Datasets and projects](#datasets-and-projects)
- [Creating a dataset](#creating-a-dataset)
- [The dataset page](#the-dataset-page)
- [Test data](#test-data)
- [Data use](#data-use)
- [Layout classes and templates](#layout-classes-and-templates)
- [Processing and re-runs](#processing-and-re-runs)
- [Reading order](#reading-order)
- [Page viewer and editor](#page-viewer-and-editor)
- [Review and correction](#review-and-correction)
- [Transcripts and exports](#transcripts-and-exports)
- [Existing transcriptions](#existing-transcriptions)
- [Corpus cut](#corpus-cut)
- [Language models](#language-models)
- [Models](#models)
- [Training](#training)
- [Evaluation](#evaluation)
- [Maps](#maps)
- [Collaboration](#collaboration)
- [Accounts and permissions](#accounts-and-permissions)
- [Profile and settings](#profile-and-settings)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [API](#api)

## Datasets and projects

The start page lists every dataset you can open, as a table or as cards.

- Search, sort, filter to your own datasets or to those that need review, and pick which
  columns to show.
- Mark a dataset **Complete** on its page once nothing more needs doing; the list shows it
  and filters by **In progress** or **Complete**.
- Datasets are grouped into projects. Drag a dataset onto a project in the list or the
  side rail to file it there, or onto Ungrouped to take it out.
- Tick several datasets, or use a project's menu, to act on all of them at once: re-run,
  re-read, re-detect lines, change processing settings, or move them to a project. Before
  anything is queued, the confirmation says how many datasets and lines it covers and
  names any dataset it will skip, with the reason.
- A project's settings dialog sets the models, decoding and phases for every dataset in it.
  Each control starts on "leave as it is", so only what you change is written.
- Each dataset's Info panel shows who uploaded it, who it is shared with, page and line
  counts, review progress, the models it uses, who has edited it and its size on disk.
- Admins can view the list as a chosen person sees it.

## Creating a dataset

Choose **New job** and go through five steps: **Source**, **Pages**, **What to run**,
**Models and conventions** and **Review**. A summary beside them fills in as you go and leads
back to any step; going back keeps everything chosen. A step with nothing to choose for the
dataset at hand, such as models for a map or a transcribed import, is skipped. A name
another of your datasets already has stops the Source step, with a link to that dataset.

- Upload images, PDFs, a zip of scans, or a transcribed dataset as a zip, or (admins)
  point at a folder on the server. The form lists every file and lets you remove any
  before sending.
- Or paste a **IIIF** manifest address (Presentation API 2 or 3) for a text dataset; a
  collection lists its manifests to choose from. The form shows the manifest's title, page
  count, attribution and rights. The pages are downloaded through the archive's image server
  when the dataset starts, no wider than the deployment allows, and from then on behave like
  uploaded scans. A page whose image cannot be downloaded is left out with the reason and can
  be fetched again with **Retry** on the dataset page. The dataset keeps its manifest,
  attribution and rights, shows them under its name, and every export carries them. Private
  and internal addresses are never fetched.
- **Pages** shows the scans as thumbnails; untick any to leave it out, or give a range such
  as `3-22, 35`. A PDF is split into pages once it is uploaded, so it is taken whole here.
- Choose which phases run: layout detection, line detection and OCR. Layout is off by
  default; lines are then detected on the whole page. With layout on, lines can be detected
  inside each layout box instead.
- Pick the model for each phase, the OCR decoding (beam search with a language model, beam
  search reranked by the decoder, or fast greedy), and the transcription convention flags
  (for example long s or typographic punctuation). Every flag is offered with what it means;
  one the chosen OCR model ignores stays set on the dataset as a rule for annotators and
  for a later model.
- The **Conventions** page, opened from the Models page or from **What these mean** beside the
  flags, lists every flag with how many models read it and how many datasets ask for it. A
  flag a model declares is added by itself; admins write its label and description, and can
  add a flag ahead of any model that reads it.
- Pick a layout template; it decides the dataset's layout classes.
- Pages are sorted in natural order (`scan_2` before `scan_10`).
- Photos are turned upright from their EXIF data, 16-bit scans are converted to 8-bit and
  transparent backgrounds are laid on white.
- A file identical to one already in the dataset is kept as a *duplicate* and skipped
  everywhere. A file that cannot be read as an image is marked *unreadable* with the
  reason; the rest of the dataset is processed as usual.
- The owner of a dataset can add pages later from the dataset page.
- A large volume sent with the Python client arrives in parts; the dataset shows as *uploading* until the last part is in. If the upload broke off, resume it from the client, or start it as it is with **Start processing**.

## The dataset page

A dataset opens on a table of its pages with a preview of the selected scan beside it.

- The header has one row per kind: the actions (Review, Run, Export, **⋯**); a line of
  facts (owner, pages, the IIIF manifest it came from, its note); its state as chips
  (pipeline steps, pages checked, test pages, data-use limits, Complete); and the three
  views **Pages**, **Transcript** and **Corpus** as tabs, which the other two views show too.
- Filter chips narrow the table to pages that still need work, are reviewed, have no
  layout, and so on. The arrow keys move the preview through the list.
- Long datasets load a screenful at a time; **Show more** loads the next.
- When a run fails, its pipeline step turns red; click it for the reason.
- The **Run** menu holds everything that runs models on the whole dataset. Work your edits
  left behind, such as lines to read again or boxes whose lines need detecting again, is
  counted on the menu and listed first. Rarer actions (settings, layout classes, language
  model readings, purging deleted pages) are in the **⋯** menu.
- A run started elsewhere (another tab, a colleague, the API) shows up within seconds.
- Anyone who can edit the dataset can delete pages and restore them from the Deleted
  filter.

## Test data

- A page is test data or not. No training uses a test page, nor any page with the same scan;
  a run leaves those out and says how many ("12 pages left out: same scan as test pages in
  Zollbuecher").
- The owner of a dataset, or an admin, marks pages as test data: one page with its **Test**
  cell in the page table or **Test page** in the page viewer, a selection with **Mark as test
  pages**, or the whole dataset with **Test data** in the dataset's title.
- **Test data** shows how much of the dataset is test data. Choosing the whole dataset there
  makes pages added later test data too. Uploads have an **Add as test pages** checkbox,
  preset from it.
- Test pages stay fully editable. The dataset list shows "test set" or "40 of 300 test pages"
  and filters by **Has test data**.

## Data use

What a dataset may be used for is its owner's call. Four switches, all on unless the owner
turns one off, apply to everyone, the owner and admins included:

- **Training:** the dataset may train or validate a model. Switched off, the training form
  does not offer it ("2 datasets you can open are not offered") and a run that was already
  queued stops before it cuts any material.
- **Test set:** the dataset may score models, as a training's test set or in an evaluation.
- **External LLM providers:** its pages may go to LLM connections an admin has not marked
  **Self-hosted** (Settings, on the connection). Switched off, only self-hosted models can
  read it, and a reading queued earlier is not sent.
- **Export by others:** the people it is shared with, admins included, may export it. The
  owner always can. Viewing and editing are not affected.

The switches are set on the wizard's Review step and changed later on the same step of the
dataset's **Settings**. There it also lists the models already trained, validated or scored
on the dataset; switching training off leaves them as they are, so an admin has to remove
one that must go. Every model records the datasets it was made from.

Others see a switched-off use as a chip beside the owner's name ("no training"). Admins can
still open any dataset for support: while a dataset restricts any use, each visit by an admin
who neither owns it nor has it shared is listed under **Opened by admins** in the dialog.

## Layout classes and templates

Every dataset has its own layout classes, copied from a template when it is created.

- A class is either **content** (holds text, its lines are read) or a **container** (groups
  the boxes inside it, read top to bottom like a column or left to right like a table).
- **Layout templates** lists all templates. Create one from scratch, copy another, or save a
  dataset's classes with **Save as template**. The built-in Schematismus template cannot be
  changed, only copied.
- Edit a dataset's classes from **Layout classes** in the **⋯** menu on its page: rename,
  recolour, change the type, or remove a class and delete or reassign its boxes. Every
  change can be undone.
- When a layout model predicts labels the dataset does not have, the Processing dialog
  asks which class each label becomes, or whether to leave it out.

## Processing and re-runs

Open **Settings** from a dataset's **⋯** menu, on its page or in the dataset list, to change
how it is processed: the New job steps open filled in as the dataset stands, without the
source and pages. Changes apply to the next run; nothing already recognised is thrown away.

- Rename the dataset on the first step; a name another dataset has is refused there.
- Choose the phases, the line detection, whether layout elements are boxes or polygons, the
  page structure used for reading order, the models, decoding and convention flags, the
  language models that read it, and its data use.
- When the OCR settings change, Review offers to re-read the unchecked lines at once.
- A map dataset keeps a smaller **Settings**: its name, and its tile size if it cut its own tiles.
- **Re-run** a phase over the dataset (from the **Run** menu on its page), a selection of
  pages, or a single page. The dialog says what will be replaced before it runs.
- When a step of a dataset was run with a model that has since been replaced (by a new
  default, a new version, or a model changed under Settings), its owner is asked on
  opening it. Each step is listed with the old and new model and what running it again
  would do. Re-reading is ticked by default and leaves checked lines alone; layout and
  lines start unticked. **Switch and run** moves the dataset to the ticked models and runs
  them; **Not now** asks again only when an even newer model appears.
- Re-reading never touches lines a person has checked, unless you explicitly ask it to.
- When lines are re-detected, the text of the old lines is kept and matched onto the new
  ones. A correction lands back on its line where the shape barely changed, and is offered
  as a reading where it changed more.
- Vertical lines are read in both directions and the more confident reading is kept.
- Turn a scan that arrived the wrong way up from the page viewer's **Run** menu. Boxes and
  lines turn with it, and turning back restores the original file.
- The **Queue** page shows everything running or waiting - datasets, trainings,
  evaluations - on a timeline per GPU and on the cluster, each item as long as it is
  expected to take, with the time it should start. Estimates come from the item's own
  progress, else from how long the same kind of work took recently. Their owner, or an
  admin, can cancel them there.

## Reading order

DeepLabel puts the lines of each page in reading order and keeps it up to date as you edit.

- Without layout boxes, tell the dataset how its pages are set (one or two leaves, one,
  two or three columns), or leave it on "work it out" to detect columns from the gaps
  between lines. A single page can override the dataset's setting in the viewer.
- With layout boxes, containers follow their own rules: a table is read column by column
  from left to right, a column from top to bottom. Everything outside containers follows
  the page structure setting.
- Lines outside every box are read where they stand, between the boxes around them.
- Drawing, moving, splitting, merging or deleting a box updates the order at once.
- Each layout template sets how pages are read; a dataset follows the template of its
  layout model.

## Page viewer and editor

The page viewer shows a scan with its layout boxes and lines, and the recognised text
beside it.

- Zoom with Ctrl and the mouse wheel or a trackpad pinch; scroll with the wheel; pan with
  Alt-drag or middle-drag. On touch screens, pinch to zoom and drag to pan. Double-click
  fits the page to the pane width.
- The line under the pointer is magnified above the text, showing exactly the crop the OCR
  model reads.
- The footer names the layout, line and OCR models that produced the page.
- Copy any scan to the clipboard as an image from the corner of the viewer.

Press `e` to edit the page.

- **Select** (`v`): click to pick a box or line, drag to move it. Shift-click or Shift-drag
  to select several.
- **Draw** (`d`): pick a class on the rail (or press its digit) and drag a box, or click
  two corners. Draw a text line in three clicks: start of the line, its end, then its
  height. Free polygons are drawn a corner per click and closed on the first corner.
- Selected lines: drag a corner to resize, drag the ring to rotate (Shift snaps to 5
  degrees), `,` and `.` turn by one degree. Switch a line to a polygon to follow a curved
  baseline.
- `s` splits along a stroke drawn across a box or line; `m` merges the selection.
- **Erase** (Shift+E): sweep away line corners with a brush. Lines you or others have
  checked are skipped unless you hold Shift.
- Hold Space or Alt for the hand tool.
- In edit mode, Layout and Lines hide the boxes or the lines while you edit; editing always
  starts with both shown, and the view keeps its own setting.
- Delete a line straight from the text list with its trash can, without entering edit mode.
- Ctrl+Z undoes and Ctrl+Shift+Z redoes any edit, including merges and splits, in or out of
  edit mode.

## Review and correction

- Move through lines with the arrow keys (or `j`/`k`). Enter edits a line; Enter, Escape
  or clicking away saves it without checking; Shift+Enter saves, checks it and moves to the
  next line, across page breaks.
- **Review** on the dataset page walks the flagged, low-confidence lines of the whole dataset.
- Every reading held for a line - the OCR model's, a language model's, an aligned
  transcription, an earlier correction - is listed under it. Click one to make it the
  line's text. The reading it replaces stays in the list, so nothing is lost.
- The readings a line already uses are listed too, marked "in use". Any reading can be
  released back to the page's unmatched readings from there, and a language model's
  reading deleted with its trash can.
- Readings that matched no line are listed on the page; drag one onto the line it belongs
  to.
  Click their heading to fold them down to their count; the choice is remembered.
- The "edited" or "settled" chip on a line is also its revert button: it puts the line back
  to its OCR text and unchecks it.
- Mark a page's layout as complete separately from its lines; the page table filters on
  both.
- The page table's **Status** column says how far a page has come: Waiting, Uploaded, Layout
  found, Lines found or Read (Processed for map tiles), or Duplicate or Unreadable.
- Build your own character keyboard under Settings, from a grid of characters grouped by
  script or from presets, or let it fill itself with the characters the dataset uses. The
  bar sits above the status bar; drag its top handle to move it anywhere, put it back with
  **Dock** or by dragging it to the bottom edge, and drag its corner to resize it. Position
  and size are remembered.
- The page header shows the live CER and WER of the OCR model against the lines people
  have checked.

## Transcripts and exports

- **Transcript** reads a dataset as a volume: the scan on one side, its text on the other,
  page by page. Turn pages with the arrows or `j`/`k`.
- Search fuzzily, exactly, case-sensitively or by regular expression. `n` and `p` step
  through the hits, and a strip along the edge shows which pages hold them.
- `f` opens a distraction-free reading view.
- Export a dataset as PAGE XML, ALTO, hOCR or TEI with its scans, as JSON, Markdown, plain
  text or DeepLabel's own zip, either complete or only what was reviewed. Lines inside
  tables and other containers are included.
- A dataset imported from IIIF also exports as **Web Annotations** (under IIIF in the
  Export menu): one annotation page per canvas, each line with its text placed on the
  original canvas, so an archive can show the transcription in its own viewer (Mirador,
  Universal Viewer).
- A DeepLabel zip export can be uploaded to another instance and arrives with its classes,
  text, corrections and review state intact.

## Existing transcriptions

Bring the ground truth you already have.

- **Page transcriptions:** upload `scan_7.txt` next to `scan_7.png`. After OCR, each
  transcription line is matched to the best-fitting recognised line. Near-exact matches
  are checked automatically; if you say the transcription lists every line in reading
  order, weaker matches that follow that order are checked too. Text files must be UTF-8
  or UTF-16.
- **PDF text layer:** tick "take the transcription from the text layer" for born-digital
  PDFs. This text fills in corrections but is never checked automatically.
- **Transkribus, eScriptorium and other tools:** upload a PAGE XML, ALTO, hOCR or TEI
  export zipped with its images.
  Pages, regions, line polygons and text are imported as they are, with no recognition run.
- Change the alignment settings under Processing and re-run **Alignment** to match again.
  Lines a person checked or corrected are kept; the aligned text is offered as a reading.

## Corpus cut

For transcriptions that exist as whole documents (a letter, an entry, a chapter) spanning
several pages.

- Upload the document `.txt` files beside the scans. Any `.txt` not named after an image is
  treated as a document. The documents only need to sort in the same order as the pages.
- After OCR, the corpus is cut onto the pages by anchoring recognised lines to corpus
  lines. Each page gets a generous span of the document.
- The dataset's **Corpus** page lists the documents, shows each page's span (pages that
  anchored nothing first), and lets you cut again after the OCR or the corpus improves.
- A language model can then read each page against its span, producing a diplomatic
  transcription of the page as it stands. This text is matched to the lines like any
  transcription, but is never checked automatically. Struck-out words are written as
  `<del>` and additions as `<add>`.

## Language models

Any OpenAI-compatible endpoint (a hosted provider, vLLM, Ollama) can read pages as a second
reader.

- Add a connection under Settings. **Ask what it offers** tests it and lists its models.
  Connections are private; an admin can publish one to everyone, and mark one as
  **Self-hosted** for datasets that keep their pages in the house ([Data use](#data-use)).
  API keys are stored encrypted and never shown again in full.
- Each model can have its own prompt, token limit and extra request fields. A dataset can
  have its own prompt and up to four reference images (for example a glyph chart).
- Start a reading from the dataset, a page selection, or a single page in the viewer. The
  dialog shows the number of calls before anything is sent. A scan already read by the
  same model and prompt is not sent again.
- Readings are matched to the detected lines and offered on each line.
- The dataset page shows each model's progress. A failed reading shows as a red count on its
  model; click it for the reason and **Retry failed**, which asks again for the failed pages only.
- **Agreement:** when enough readers agree on a line, its text is filled in, and
  optionally checked. Hover the agreement badge to compare every reader's text. The OCR
  model does not vote by default. Agreement never overwrites a person's correction or
  check.
- **Re-apply LLM agreement** (in the dataset page's **⋯** menu) applies changed agreement
  settings to lines already read; **Remove LLM readings** deletes a model's readings from a
  dataset. **Remove readings** in the page viewer's **Run** menu does the same for one page.
- A deployment can switch the feature off entirely.

## Models

Every model is served by a model backend, a separate service that runs it. Operators set
backends up as described in [MODEL-BACKENDS.md](MODEL-BACKENDS.md).

- The **Models** page has a tab per task (OCR, layout, lines) and a **Runs** tab. Models are
  grouped into families: a base model and everything fine-tuned from it, drawn as a
  version graph with each version's score.
- Each model has its own page with its lineage, scores, decoding settings, evaluations,
  notes and the run that produced it, plus **Evaluate**, **Set default**, **Edit** and
  **Archive**.
- Every task has a default model. Archived models leave the pickers but stay on record and
  can be unarchived.
- Mark a model as the **new version of** another under **Edit**, even when it was not
  trained from it. Its page then shows "New version of ..." and "Replaced by ...", and its
  family graph draws the versions as one line, each fine-tune branching off its own version.
- You manage the models your own trainings produced; people with the model-management
  permission manage all of them.

## Training

Start a run with **Train model** on the Models page. Training runs on the model's backend, either on the
local GPU or on a Slurm cluster (marked *highly experimental*).

- Pick the base model, the datasets (by project, with search), the validation split and
  optionally one or more test sets: the test pages of datasets, scored with the base and the
  new model once the run is trained. **Select all** takes every dataset the search shows,
  or every test set.
- Train only on lines a person verified, or include lines settled by language-model
  agreement.
- Tune epochs, batch size, learning rate, early stopping and every other setting the
  trainer offers; empty fields use the trainer's defaults, which are shown.
- For OCR, optionally fit a language model to the training text. For line models, choose
  the line shape to train on.
- An OCR run trains each line under its dataset's convention flags. It keeps every flag its
  base model knew and can teach it new ones; the pre-flight names what the run teaches, how
  many training lines carry each flag, and warns when a new one has too few to be learned.
- **Next** opens a pre-flight review of exactly the material the run will use: the split,
  crop sizes, characters per line and a character table that flags rare characters,
  lookalikes (such as a Cyrillic a in Latin text), characters only in validation, and
  mixed Unicode forms. It warns but never blocks.
- The run page has tabs for Overview, Curves, Data, Evaluations and Settings. Curves are
  drawn per metric, with smoothing, log scale, zoom and a shared crosshair.
- **Rerun**, in a run's **⋯** menu, opens a finished run's settings in a new form.
- **Augmentations** (under Models) builds augmentation pipelines from the trainer's
  catalogue, with groups and a live preview, on an **OCR** and a **Layout** tab. OCR
  previews one real line crop (Change lines draws another); Layout previews a page with
  checked layout, its boxes outlined before and after, so a step that moves the page shows
  whether the boxes moved with it. The layout trainer refuses a group below p 1 and a step
  that would move the page without its boxes. Pipelines are private; an admin can make one
  a task's default.
- If the cluster asks for a second factor, an admin unlocks it from the training form.
  Admins grant training per person and per target (local or cluster).

## Evaluation

- **Evaluations** (under Models) draws one ruler per dataset or validation split, with each
  model as a dot at its CER on a marked scale, the best in green. Test pages come first and are marked as
  such; a run's validation split comes last and is marked too, since it chose the
  checkpoint and reads optimistic. Click a dot for its scores in every decode and a link to
  each evaluation. **Table** lists them all instead.
- Evaluate any OCR model on any dataset's checked lines with **Evaluate...** on its page; a
  dataset with test pages is scored on those, unless **All pages** is chosen. Training runs
  are evaluated automatically on their validation split and test pages.
- A queued or running evaluation can be cancelled by its owner or an admin. It keeps its
  place in the list without scores, and **Retry** runs it again.
- Each evaluation has a page with CER, WER, bag-of-words WER, error types and accuracy per
  character class.
- **Lines** lists every scored line with its crop, a character-level diff, CER and
  confidence; sort, filter and search them, and open any line in the editor.
  **Send to review** flags the current lines for review.
- **Confusions**, **Characters** and **Context and calibration** break the errors down by
  character, line length, dataset, page and confidence.

## Maps

Maps are a separate task with a tile editor, in two kinds: *map segmentation* (class
polygons) and *line tracing* (boundary lines, open or closed).

- Upload pre-cut tiles, or full map scans that are cut into square tiles (512 px unless you
  choose another size). Near-blank tiles are skipped.
- A segmentation model can pre-annotate every tile. If the deployment has no map model,
  these options are switched off on the form.
- Each dataset has its own class palette. Rank the classes to decide which wins where
  polygons overlap; **Resolve overlaps** (`x`) clips them accordingly.
- Draw shapes point by point, or trace freehand by holding the button. New points snap to
  existing outlines, so neighbouring shapes share an edge. Bring a shape back to its first
  point to close it; Enter, right-click or double-click finishes it anywhere.
- Select to move whole shapes or groups of points, `m` merges, `s` cuts a line, `g` cuts a
  hole, `p` reduces polygon points, and Shift+E erases points with a brush.
- On line tiles, the **Detect** tool (`t`) traces edges inside an outlined area.
- Re-predicting replaces model annotations but keeps human edits.
- Reviewed tiles export as class-index PNG masks with geometry files for training.

## Collaboration

- **Projects and sharing:** share a dataset with people directly or through its project.
- **Notes:** a dataset and each of its pages can carry one note everyone with access can read,
  such as how far a volume has been checked. Anyone who can edit adds it with **+ Note** in
  the dataset's title or the page viewer's toolbar; a **Note** tag then marks it there, on the
  dataset list and in the page table (filter **Has note**), and opens it with who last edited
  it and when.
- **Presence:** the navigation bar shows who is online, and datasets and pages show who is
  in them. Opening a page someone else has open shows a notice. You can hide yourself or
  hide others in Settings.
- **Live edits:** a colleague's changes appear in your open page without a reload.
- **Edit conflicts:** if someone saved a line, box or region after you loaded it, your save
  is refused and both versions are shown, so you choose what to keep.
- **Undo** only takes back your own edit, and is refused if someone else has built on it.

## Accounts and permissions

Sign-in is handled by Authentik.

- Each account has a role - admin, member or viewer - which sets its permissions:
  re-running phases, discarding checked work, deleting datasets, managing models and
  training. Admins can grant or remove single permissions per person on the **Admin** page.
  Buttons you cannot use are not shown.
- The Admin page shows everyone in one table, grouped by role, with a dot per permission.
  Each role's own line shows what its people get, and an amber dot marks an exception made
  for one person; click a dot to make or lift one. Click a name for their role, cluster
  account, sessions, what they can reach and edited, and the history of changes to the
  account. API tokens have their own tab.
- Admins can invite people by email: the app creates the account and a one-time link to
  set a password, which the admin sends. See [AUTHENTIK.md](../AUTHENTIK.md).
- Admins can see and revoke every API token.

## Profile and settings

- Everyone has a profile at `/people/<username>` with their picture, role, groups, a short
  written summary of their work, work statistics (lines corrected and checked, pages signed
  off, trainings, models, best CER), a year of activity and recent datasets.
- Click your avatar on your profile to upload and crop a picture.
- Your settings are tabs on your own profile, grouped as Editing, Together and Connections:
  presence, which overlays a page opens with, keyboard shortcuts, character keyboard, API
  tokens and language models. Log out sits at the foot of that list.
- The theme (Auto, Light, Dark) is the button in the top bar, on every page.
- Settings are stored with your account and follow you to every device.
- Every page except the two editors ends with a footer naming the running version and
  commit, with links to the documentation, the source and a new issue.

## Keyboard shortcuts

Every shortcut can be changed under Settings, where a keyboard shows which keys each part
of the app uses, with or without Shift. Click a key to give it a command, or use the list
below it. Some commands (navigation, theme) start unbound.

| Where | Key | Action |
|---|---|---|
| Page viewer | `e` | Toggle edit mode |
| Page viewer | `j` / `k`, arrow keys | Next / previous line |
| Page viewer | Enter / Shift+Enter | Edit line / save, check and go to next |
| Page viewer | `i` | Step into the line's readings |
| Page viewer | `o` | Re-read the focused line |
| Page viewer | `r` / Shift+R | Rotate line clockwise / counter-clockwise |
| Page viewer | `.` / `,` | Turn selected line by one degree |
| Page viewer | Shift+V | Mark page layout complete |
| Editors | `v` / `d` / Shift+E | Select / draw / erase tool |
| Editors | Space or Alt (held) | Hand tool |
| Editors | `s` / `m` | Split / merge |
| Editors | `h` / `l` | Previous / next page |
| Editors | Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Map editor | `t` | Detect edges (line tiles) |
| Map editor | `g` / `p` / `x` | Cut hole / reduce polygons / resolve overlaps |
| Transcript | `n` / `p` | Next / previous search hit |
| Transcript | `f` | Reading view |

## API

Everything the interface does is available over HTTP. Create a token under your profile's
**API tokens** tab and send it as `Authorization: Bearer <token>`. A token acts as you, can
be made read-only, and expires when you choose. The schema is at `/docs` on a running
deployment, and [API.md](API.md) has examples, including the Python client and the
`deeplabel` command-line tool.
