import json
import sqlite3
import unicodedata
from contextvars import ContextVar
from pathlib import Path

from app import caches

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    phase TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- When it last left the queue: STARTED_AT_UPDATE stamps it.
    started_at TEXT,
    -- When it last joined the queue, null while it never left it: the jobs_queued_at trigger.
    queued_at TEXT,
    source_path TEXT,
    counters TEXT NOT NULL DEFAULT '{}',
    line_mode TEXT NOT NULL DEFAULT 'per_crop',
    -- 'box' or 'polygon': whether layout elements are drawn and edited as boxes or outlines.
    layout_shape TEXT NOT NULL DEFAULT 'box',
    -- How the pages are laid out, for ordering the lines of a page with no layout boxes:
    -- 'auto' works it out per page, otherwise '<leaves>x<columns>'. See reading_order.
    reading_order TEXT NOT NULL DEFAULT 'auto',
    checked INTEGER NOT NULL DEFAULT 0,
    pid INTEGER,
    run_layout INTEGER NOT NULL DEFAULT 1,
    run_lines INTEGER NOT NULL DEFAULT 1,
    run_ocr INTEGER NOT NULL DEFAULT 1,
    task TEXT NOT NULL DEFAULT 'text',
    run_predict INTEGER NOT NULL DEFAULT 0,
    gt_autocheck INTEGER NOT NULL DEFAULT 0,
    -- Harvest ground truth from an ingested PDF's own text layer. A dataset property,
    -- not a per-upload one, so pages appended later are treated like the first batch.
    gt_from_pdf INTEGER NOT NULL DEFAULT 0,
    -- The transcription lists every line of the page, in reading order. Alignment can
    -- then take agreement with that order as proof of a pair, instead of demanding the
    -- recognition already read the line well - see app.align.autocheck_matches.
    gt_ordered INTEGER NOT NULL DEFAULT 0,
    -- Language models this dataset is pre-annotated with (JSON list of llm_models ids),
    -- how many must agree before a line counts as settled, and whether that agreement may
    -- check the line off without a person looking at it.
    llm_model_ids TEXT NOT NULL DEFAULT '[]',
    llm_consensus_min INTEGER NOT NULL DEFAULT 2,
    llm_autocheck INTEGER NOT NULL DEFAULT 0,
    -- Whether the local OCR model counts as one of the voices above. Off by default, and
    -- see app.consensus for why: on a dataset training that model it would approve its own
    -- mistakes. On for a dataset read with a checkpoint that has nothing to do with it.
    llm_consensus_with_ocr INTEGER NOT NULL DEFAULT 0,
    -- This dataset's own prompt, which replaces the model's rather than adding to it -
    -- material this specific is usually worth saying in full. Empty uses the model's.
    llm_prompt TEXT NOT NULL DEFAULT '',
    -- Whether pages added to this dataset arrive as test pages.
    new_pages_test INTEGER NOT NULL DEFAULT 0,
    -- Wording for the diplomatic reading that turns a corpus span into ground truth. It
    -- is a different question from llm_prompt - it carries the page's reference text -
    -- so it is asked separately. Empty uses the shipped one.
    gt_prompt TEXT NOT NULL DEFAULT '',
    -- The models the last diplomatic reading used (JSON list of llm_models ids), which the
    -- Corpus page starts from. Empty falls back to llm_model_ids.
    gt_model_ids TEXT NOT NULL DEFAULT '[]',
    -- Corpus lines added to each side of a page's span, absorbing the error in a cut the
    -- model can see past. A wider corpus-to-page mismatch wants a wider margin.
    reference_overlap INTEGER NOT NULL DEFAULT 2,
    -- Highest map class id removed from the palette. New classes are numbered above it,
    -- since masks and predictions made under a removed id still carry it.
    max_retired_class_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    filename TEXT NOT NULL,
    source_file TEXT NOT NULL,
    content_hash TEXT,
    width INTEGER,
    height INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    layout_checked INTEGER NOT NULL DEFAULT 0,
    lines_checked INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    source_pdf TEXT,
    source_page INTEGER,
    source_map INTEGER,  -- job_maps.id when this page is a tile cut from a full map
    tile_x INTEGER,      -- tile origin: x = row offset (first axis), old-tool convention
    tile_y INTEGER,      -- tile origin: y = column offset (second axis)
    gt_text TEXT,
    -- Where gt_text came from: 'sidecar' for a .txt the user wrote, 'pdf' for a
    -- document's own text layer. The alignment phase never auto-checks the latter.
    gt_source TEXT,
    -- A scan turned the right way up is turned for good: source_file points at the
    -- turned copy and every polygon on the page was turned with it. These two say what
    -- was done and where the scan as it arrived still is, so the next turn is derived
    -- from the original rather than from the last turn's re-encoding.
    rotation INTEGER NOT NULL DEFAULT 0,
    origin_file TEXT,
    -- This page's own layout when it differs from the volume's; NULL follows the dataset.
    reading_order TEXT,
    -- Why ingest could not read this scan, beside status 'unreadable'.
    error TEXT,
    -- Test data: never trained on, nor any page with the same scan, and what a run's
    -- test set is scored on.
    is_test INTEGER NOT NULL DEFAULT 0
);
-- Full map scans awaiting/after tiling (run_tile map jobs). A map is the source of
-- tiles, never annotated itself; its tiles are ordinary pages referencing it via
-- pages.source_map. Kept separate from pages so every pages status assumption
-- (ingest 'pending', predict 'ingested', repredict) stays untouched.
CREATE TABLE IF NOT EXISTS job_maps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    filename TEXT NOT NULL,
    source_file TEXT NOT NULL,
    content_hash TEXT,
    width INTEGER,
    height INTEGER,
    n_tiles INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | duplicate
    deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS elements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    order_idx INTEGER NOT NULL,
    class_name TEXT NOT NULL,
    raw_class_name TEXT,
    bbox TEXT NOT NULL,
    conf REAL,
    kind TEXT NOT NULL DEFAULT 'content',
    checked INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    lines_bbox TEXT,
    -- The element's outline in a polygon-mode dataset, normalised like a line's; bbox is
    -- then its bounding box. Kept when the dataset goes back to boxes, so it loses nothing.
    polygon TEXT
);
CREATE TABLE IF NOT EXISTS lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    element_id INTEGER NOT NULL REFERENCES elements(id) ON DELETE CASCADE,
    order_idx INTEGER NOT NULL,
    polygon TEXT NOT NULL,
    text TEXT,
    corrected_text TEXT,
    -- Who wrote corrected_text: a person's name, or a machine author (consensus,
    -- alignment) - MACHINE_AUTHORS tells them apart. NULL with a correction on the row
    -- means written before this was kept, and is treated as a person's.
    corrected_by TEXT,
    confidence REAL,
    conf_profile TEXT,
    orientation INTEGER NOT NULL DEFAULT 0,
    needs_ocr INTEGER NOT NULL DEFAULT 0,
    checked INTEGER NOT NULL DEFAULT 0,
    -- Who checked it: NULL or 'human' for a person, 'align' for a matched transcription,
    -- 'llm' for language models agreeing. Training and evaluation can then tell a
    -- verified line from a machine-settled one instead of trusting the flag alone.
    check_source TEXT,
    -- How many distinct language models agreed on this line's text, so the review queue
    -- can be sorted by where they agree and the local model does not.
    llm_agree_count INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0
);
-- Map annotations: class-tagged geometry on a tile (map_segmentation / map_lines jobs).
-- kind='polygon' is one outer ring plus optional holes; kind='polyline' is an open traced
-- boundary line (>= 2 points, holes always '[]'). Coordinates normalized to [0, 1] like
-- elements/lines. Kind is per-region, not per-job, so a job may later carry both.
-- Sibling to elements rather than reusing it: no bbox/kind/OCR baggage.
CREATE TABLE IF NOT EXISTS regions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    order_idx INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    points TEXT NOT NULL,
    holes TEXT NOT NULL DEFAULT '[]',
    kind TEXT NOT NULL DEFAULT 'polygon',
    checked INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0
);
-- Per-job map class vocabulary (both tile tasks). Seeded at job creation from the chosen
-- model's registry entry (or the legacy default), then editable per job. class_id is
-- immutable once assigned — regions.class_id, revision snapshots and exported mask
-- pixels all embed it — so ids are never renumbered or reused.
CREATE TABLE IF NOT EXISTS job_classes (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,            -- '[r,g,b]'
    priority_rank INTEGER NOT NULL, -- smaller = higher priority (overlap tie-break)
    PRIMARY KEY (job_id, class_id)
);
-- Layout templates (app/layout_templates.py): named class sets a dataset copies its layout
-- classes from when it is created. rules = 'schematismus' keeps that pipeline's own
-- reading rules. class_id is immutable once assigned: COCO category ids in exports,
-- training snapshots and checkpoints embed it, so ids are never renumbered or reused.
CREATE TABLE IF NOT EXISTS layout_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    owner TEXT,                     -- NULL for the built-in Schematismus template
    rules TEXT,
    -- How what stands outside every container reads: 'top_to_bottom' by
    -- its centre, as the Schematismus pipeline does, or 'from_page' by leaves and columns.
    outside_order TEXT NOT NULL DEFAULT 'from_page',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS layout_template_classes (
    template_id INTEGER NOT NULL REFERENCES layout_templates(id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'content',   -- 'content' or 'container'
    reads TEXT,                             -- a container's direction: 'down' or 'across'
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (template_id, class_id)
);
-- A text dataset's own copy of its template's classes.
CREATE TABLE IF NOT EXISTS job_layout_classes (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'content',
    reads TEXT,
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, class_id)
);
-- What a dataset does with a layout model's label its classes lack: the class
-- it is read as, or NULL to leave such boxes out. A label matching a class by name needs no row.
CREATE TABLE IF NOT EXISTS layout_label_maps (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    model_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    class_id INTEGER,
    PRIMARY KEY (job_id, model_id, label)
);
-- Append-only edit log. Newest revision per target mirrors the materialized row;
-- readers use the row, never fold the chain. No foreign keys: the log outlives
-- its subject, and job_id is denormalized for the same reason.
CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    author TEXT NOT NULL,
    action TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    client_id TEXT
);
CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'builtin',
    checkpoint TEXT NOT NULL,
    trained_from INTEGER REFERENCES models(id),
    metrics TEXT,
    notes TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    lm_path TEXT,
    lm_dict_path TEXT,
    -- What the model resizes a line crop to before reading it. Null until something has
    -- loaded the checkpoint and said so; the app venv is torch-free and cannot ask it.
    target_height INTEGER,
    max_width INTEGER,
    -- The model backend that serves it (NULL: the task's default backend), the weights
    -- family that backend must declare, and for map models their classes, window and the
    -- id they had in models/mapseg/registry.json.
    backend TEXT,
    model_type TEXT,
    classes TEXT,
    input_size INTEGER,
    ref TEXT,
    -- JSON list of the transcription-convention flags an OCR model is conditioned on, in
    -- its own order. Null until a run has loaded the checkpoint and said so.
    conventions TEXT,
    -- A family's own name, kept on its root (the model trained from scratch or brought in).
    -- Null: the family is called after the root.
    family_name TEXT,
    -- The layout template a layout model was trained on, whose reading order the datasets
    -- it reads follow. Null: their order is worked out from the page.
    layout_template_id INTEGER REFERENCES layout_templates(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The files of a model as the weight store holds them, by content (WEIGHTS_DIR/<sha[:2]>/<sha>).
CREATE TABLE IF NOT EXISTS model_files (
    model_id INTEGER NOT NULL REFERENCES models(id),
    role TEXT NOT NULL,
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (model_id, role)
);
CREATE TABLE IF NOT EXISTS trainings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    name TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    base_model_id INTEGER REFERENCES models(id),
    target TEXT NOT NULL DEFAULT 'local',
    -- The model backend a run trains on - on the backend itself, or on the cluster in its
    -- image - and a local run's id there; NULL for a run trained in-process.
    backend TEXT,
    backend_train_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    phase TEXT,
    error TEXT,
    dataset_job_ids TEXT NOT NULL DEFAULT '[]',
    epochs INTEGER,
    batch_size INTEGER,
    gpu_type TEXT,
    gpu_count INTEGER,
    hyperparams TEXT NOT NULL DEFAULT '{}',
    description TEXT,
    val_fraction REAL NOT NULL DEFAULT 0.1,
    split_strategy TEXT NOT NULL DEFAULT 'uniform',
    valid_job_ids TEXT NOT NULL DEFAULT '[]',
    -- Datasets held out as a test set: never trained on, evaluated with the base and
    -- the new model once the training finishes.
    test_job_ids TEXT NOT NULL DEFAULT '[]',
    -- Train only on lines a person verified, leaving out those language models settled
    -- among themselves. Off by default: the agreement is usually the point of running
    -- them, and a run that wants a clean corpus says so.
    human_checked_only INTEGER NOT NULL DEFAULT 0,
    -- Fit a KenLM to this run's own ground truth and give it to the model it produces,
    -- instead of inheriting a general one built for other material.
    build_lm INTEGER NOT NULL DEFAULT 0,
    -- How that build went, 'built' or 'failed', written when it ends. NULL until then, and
    -- on runs from before it was kept, which read it off the run's folder instead.
    lm_build TEXT,
    -- The augmentation stack this run trains with, frozen at submit in albumentations'
    -- own dict form. NULL leaves the train module on its built-in stack; an empty step
    -- list trains on clean crops. Frozen rather than referenced, so editing or deleting
    -- the pipeline it came from never rewrites what a finished run did.
    augmentation TEXT,
    -- The pipeline the stack was taken from, for the run's record; empty when it was
    -- built for this run alone.
    augmentation_name TEXT NOT NULL DEFAULT '',
    -- SLURM account this run is charged to, empty to fall back to the cluster-wide one.
    -- Copied from the submitter rather than read at submit time, so a retry charges the
    -- same account even if theirs has changed since.
    slurm_account TEXT NOT NULL DEFAULT '',
    snapshot_counts TEXT,
    -- {done, total} while the snapshot is being cut, so a long preparation reads as
    -- progress rather than a hang. Cleared once the training itself starts.
    snapshot_progress TEXT,
    metrics TEXT,
    model_id INTEGER REFERENCES models(id),
    slurm_job_id TEXT,
    pid INTEGER,
    -- Counts the submits this run has had. A retry raises it, and a submit only reports
    -- while the run still carries the number it started under - so the thread of an
    -- attempt that was replaced cannot write its failure over the one that replaced it.
    attempt INTEGER NOT NULL DEFAULT 1,
    -- The statistics reviewed before the run started, kept for its page.
    preflight_id INTEGER REFERENCES training_preflights(id),
    -- How a run on a model backend was scaled (MODEL-BACKENDS.md 6.9): the gradient
    -- accumulation and learning-rate factor sent with batch_size, what the out-of-memory
    -- fallback changed them to (JSON {asked, trained}), and how often a cluster run was
    -- resubmitted from its checkpoint after hitting the time limit.
    grad_accum_steps INTEGER,
    lr_scale REAL,
    batch_fallback TEXT,
    resumes INTEGER NOT NULL DEFAULT 0,
    -- The metrics its backend declared (JSON list of {key, label, unit, better, headline,
    -- detail}), kept when the run starts so its page reads them as the trainer meant.
    metric_info TEXT,
    -- What a lines run trains each line as: polygon, rotated or box (line_shapes).
    line_shape TEXT,
    started_at TEXT,
    queued_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A review of the material a training would be cut from, computed in the background
-- for the settings in `request` (the training's own body, minus its name and description).
CREATE TABLE IF NOT EXISTS training_preflights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    task TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',  -- running | done | error
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS training_preflights_by_owner ON training_preflights(owner, id);
CREATE TABLE IF NOT EXISTS augmentation_pipelines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    -- albumentations' own dict form, what the trainer loads with A.from_dict.
    spec TEXT NOT NULL,
    -- The one pipeline per task an admin marked as what "Default" means in the training
    -- dialog: visible to everyone, editable by its owner alone.
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- OpenAI-compatible endpoints registered for LLM pre-annotation. The key is encrypted
-- with LLM_SECRET_KEY and never leaves the backend; api_key_hint is its last characters
-- in the clear, so two keys can be told apart without decrypting anything. A connection
-- is private to its owner until an admin publishes it (shared = 1), which is how a
-- keyless in-house endpoint becomes usable by everyone.
CREATE TABLE IF NOT EXISTS llm_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT,
    api_key_hint TEXT,
    shared INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each person's own default transcription prompt: what a model with no wording of its own
-- is asked with, for runs that person starts. Empty or absent means the shipped default.
-- A picture the models are shown before the page: a chart of the glyphs a corpus uses, a
-- specimen alphabet. Held per person as their default, and per dataset where a corpus needs
-- its own - the same two scopes the prompt has, and replaced the same way rather than added
-- to. The bytes live here so a chart cannot go missing from a disk the backend no longer has.
CREATE TABLE IF NOT EXISTS llm_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
    order_idx INTEGER NOT NULL DEFAULT 0,
    filename TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT 'image/png',
    bytes BLOB NOT NULL,
    digest TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_llm_references_scope ON llm_references(owner, job_id, order_idx);
CREATE TABLE IF NOT EXISTS llm_prompts (
    owner TEXT PRIMARY KEY,
    prompt TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One model a connection offers. Several per connection is the point: one endpoint, one
-- credential, many models to read a page with. The prompt lives here rather than on the
-- connection because how a model must be asked is a property of that model.
CREATE TABLE IF NOT EXISTS llm_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL REFERENCES llm_connections(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    label TEXT NOT NULL,
    -- This model's own wording. Empty follows the running person's default, so editing
    -- that default reaches every model nobody has given words of its own.
    prompt TEXT NOT NULL DEFAULT '',
    temperature REAL NOT NULL DEFAULT 0,
    -- Longest edge of the image sent, in pixels. 1600 is the cached screen rendition,
    -- so the default costs no extra rendering; dense small print wants more.
    max_image_edge INTEGER NOT NULL DEFAULT 1600,
    -- Ceiling on the answer, NULL for the endpoint's own. A reasoning model spends this
    -- on thinking before it writes a line, so it is left unset unless asked for.
    max_tokens INTEGER,
    -- Extra request fields merged into the call, as a JSON object. This is where a
    -- provider's own switches live - a reasoning model is quietened with
    -- {"chat_template_kwargs": {"enable_thinking": false}} - without this client having
    -- to know one vendor from another.
    extra_body TEXT NOT NULL DEFAULT '{}',
    -- How many of the worker's slots this model may hold at once, NULL for as many as
    -- there are. LLM_MAX_CONCURRENCY is the machine's ceiling; this is the provider's,
    -- where one endpoint rate-limits harder than the rest.
    max_concurrency INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id),
    training_id INTEGER REFERENCES trainings(id),
    source TEXT NOT NULL DEFAULT '{}',
    decode TEXT NOT NULL DEFAULT 'beam',
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    cer REAL,
    wer REAL,
    line_count INTEGER,
    -- Per-dataset scores as JSON, when the scored material spans several datasets.
    breakdown TEXT,
    owner TEXT NOT NULL DEFAULT '',
    pid INTEGER,
    fingerprint TEXT,
    started_at TEXT,
    queued_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One scored line of an evaluation, as the evaluator recorded it. Copies of the text
-- rather than references, so the page still shows what was scored after the line is
-- corrected. Keyed by line id, so a second evaluation joins the same rows.
CREATE TABLE IF NOT EXISTS eval_lines (
    evaluation_id INTEGER NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
    line_id INTEGER NOT NULL,
    job_id TEXT,
    page_id INTEGER,
    decode TEXT NOT NULL DEFAULT '',
    ground_truth TEXT NOT NULL,
    prediction TEXT NOT NULL,
    cer REAL NOT NULL,
    distance INTEGER NOT NULL,
    length INTEGER NOT NULL,
    confidence REAL,
    -- The character-level diff as JSON [kind, truth, read] segments.
    ops TEXT NOT NULL,
    PRIMARY KEY (evaluation_id, line_id)
);
CREATE INDEX IF NOT EXISTS eval_lines_by_cer ON eval_lines(evaluation_id, cer);
CREATE INDEX IF NOT EXISTS eval_lines_by_confidence ON eval_lines(evaluation_id, confidence);
CREATE INDEX IF NOT EXISTS eval_lines_by_length ON eval_lines(evaluation_id, length);
-- Lines sent to their dataset's review queue from an evaluation, checked or not. A
-- person's check or correction takes the flag off.
CREATE TABLE IF NOT EXISTS review_flags (
    line_id INTEGER PRIMARY KEY REFERENCES lines(id) ON DELETE CASCADE,
    evaluation_id INTEGER REFERENCES evaluations(id) ON DELETE SET NULL,
    flagged_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS review_flags_by_evaluation ON review_flags(evaluation_id);
-- One language model's reading of one scan: the expensive artifact, kept so that
-- re-matching it against re-detected lines never costs another call. Keyed by the image's
-- content hash rather than the page, so the same scan ingested into a second dataset
-- reuses the reading already paid for. Rows outlive the pages that prompted them, which
-- is why there is no page reference here.
CREATE TABLE IF NOT EXISTS llm_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_hash TEXT NOT NULL,
    llm_model_id INTEGER NOT NULL,
    model TEXT NOT NULL DEFAULT '',      -- the provider's model id at the time of the read
    label TEXT NOT NULL DEFAULT '',      -- what it was called, so a deleted model still reads
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
    raw_text TEXT,
    -- What a re-read is replacing, kept while its call is out: claiming the row clears
    -- raw_text, so a failure, a restart or a withdrawal puts this back instead of losing
    -- an answer already paid for.
    previous_text TEXT,
    error TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    -- Digest of the prompt this answer was produced with. A reading is never re-fetched
    -- because the prompt changed, but the dataset can see that it was read under older
    -- wording and ask for it again.
    prompt_hash TEXT,
    -- The dataset that asked for it, whose wording was used. A reading serves every
    -- dataset holding the scan, so the others may see it was read under other wording.
    job_id TEXT,
    requested_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    UNIQUE (content_hash, llm_model_id)
);
-- Every transcription a page has ever carried, whether or not it currently has a line to
-- sit on: what OCR read, what a person corrected, what a language model returned. Written
-- before anything that destroys a line, and re-matched against the new lines afterwards -
-- by overlap when the entry remembers the box it was read from, by text when it does not.
-- line_id deliberately carries no foreign key: entries outlive the lines they came from,
-- which is the whole point of keeping them.
CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    line_id INTEGER,
    source TEXT NOT NULL,               -- 'ocr' | 'human' | 'align' | 'llm'
    author TEXT NOT NULL DEFAULT '',    -- the revision author that produced the text
    -- Which registered language model said it. Two connections may serve the same model
    -- under the same name, and agreement has to count models rather than labels.
    llm_model_id INTEGER,
    text TEXT NOT NULL,
    order_idx INTEGER NOT NULL DEFAULT 0,
    polygon TEXT,                       -- the geometry it was read from, when it had one
    similarity REAL,                    -- how well it matched the line it sits on
    checked INTEGER NOT NULL DEFAULT 0, -- whether a person had verified it
    dismissed INTEGER NOT NULL DEFAULT 0,
    -- The revision of the edit that set it aside, so taking that edit back offers it
    -- again. NULL where a re-read superseded it: a newer answer is not an edit to take back.
    set_aside_at INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS job_assignees (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    PRIMARY KEY (job_id, username)
);
CREATE TABLE IF NOT EXISTS group_assignees (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    PRIMARY KEY (group_id, username)
);
CREATE INDEX IF NOT EXISTS idx_pages_job ON pages(job_id);
CREATE INDEX IF NOT EXISTS idx_elements_page ON elements(page_id);
CREATE INDEX IF NOT EXISTS idx_lines_element ON lines(element_id);
CREATE INDEX IF NOT EXISTS idx_regions_page ON regions(page_id);
CREATE INDEX IF NOT EXISTS idx_job_maps_job ON job_maps(job_id);
CREATE INDEX IF NOT EXISTS idx_llm_reads_status ON llm_reads(status);
-- Which datasets asked for a reading. One scan read by one model is bought once and kept
-- once, but the answer is only put on the pages of a dataset that asked for it: holding
-- the same scan as somebody else is not a reason to be given what they paid for.
CREATE TABLE IF NOT EXISTS llm_read_jobs (
    read_id INTEGER NOT NULL REFERENCES llm_reads(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    PRIMARY KEY (read_id, job_id)
);
-- A transcribed corpus as it was uploaded: one row per text file, in filename order,
-- each covering however many leaves it was written on. Kept whole rather than cut up,
-- so the cut into per-page reference text can be redone whenever recognition improves.
CREATE TABLE IF NOT EXISTS job_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (job_id, name)
);
CREATE INDEX IF NOT EXISTS idx_job_documents_job ON job_documents(job_id, idx);
-- A model's diplomatic reading of one page, taken with that page's reference text in
-- the prompt. Page-scoped rather than scan-scoped, unlike llm_reads: the same scan in
-- another dataset is cut from another corpus, so the answer does not carry over.
CREATE TABLE IF NOT EXISTS gt_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    llm_model_id INTEGER NOT NULL,
    model TEXT NOT NULL DEFAULT '',   -- the provider's model id at the time of the read
    label TEXT NOT NULL DEFAULT '',   -- what it was called, so a deleted model still reads
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
    raw_text TEXT,
    previous_text TEXT,                -- what a re-read replaces, as in llm_reads
    error TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    -- Digest of the wording and reference this answer was produced with, so a page whose
    -- cut has since moved can be told from one still reading what it was asked about.
    prompt_hash TEXT,
    requested_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    UNIQUE (page_id, llm_model_id)
);
CREATE INDEX IF NOT EXISTS idx_gt_reads_status ON gt_reads(status);
CREATE INDEX IF NOT EXISTS idx_gt_reads_job ON gt_reads(job_id);
CREATE INDEX IF NOT EXISTS idx_candidates_page ON candidates(page_id);
CREATE INDEX IF NOT EXISTS idx_candidates_line ON candidates(line_id);
CREATE INDEX IF NOT EXISTS idx_llm_models_connection ON llm_models(connection_id);
CREATE INDEX IF NOT EXISTS idx_revisions_target ON revisions(target_type, target_id, id);
CREATE INDEX IF NOT EXISTS idx_revisions_job ON revisions(job_id, id);
-- Per-person activity on the Users page reads the log by author.
CREATE INDEX IF NOT EXISTS idx_revisions_author ON revisions(author, id);
-- Which datasets are shared with the caller, asked by every non-admin dataset list.
CREATE INDEX IF NOT EXISTS idx_job_assignees_user ON job_assignees(username);
CREATE INDEX IF NOT EXISTS idx_group_assignees_user ON group_assignees(username);
CREATE INDEX IF NOT EXISTS idx_model_files_sha ON model_files(sha256);
"""


# user_version gates the data migrations, which unlike an added column must not or
# need not run on every open: a relabel would flip a later deliberate choice back, and a
# backfill would scan its table on every request (connect() runs per request). Each
# block sets the version it is named for, so they run in this order inside connect().
DECODE_RELABEL = 1
CORRECTED_BY_BACKFILL = 2
PROVENANCE_BACKFILL = 3
TEXT_COMPOSED = 4


def _mark_former_test_sets(conn: sqlite3.Connection) -> None:
    """Before pages were marked, a run named whole datasets as its test set. Their pages
    become test pages, so no later run trains on what an earlier one was scored on."""
    conn.execute('ALTER TABLE pages ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0')
    if 'new_pages_test' not in {row[1] for row in conn.execute('PRAGMA table_info(jobs)')}:
        conn.execute('ALTER TABLE jobs ADD COLUMN new_pages_test INTEGER NOT NULL DEFAULT 0')
    tested = {job_id for row in conn.execute('SELECT test_job_ids FROM trainings')
              for job_id in json.loads(row['test_job_ids'] or '[]')}
    for job_id in tested:
        conn.execute('UPDATE pages SET is_test = 1 WHERE job_id = ?', (job_id,))
        conn.execute('UPDATE jobs SET new_pages_test = 1 WHERE id = ?', (job_id,))


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # Switching journal mode takes an exclusive lock and, unlike ordinary writes,
    # returns BUSY instead of waiting out busy_timeout. Setting it only when it is
    # not already WAL keeps concurrent openers off that path - otherwise the first
    # connections to a fresh database race and one of them dies.
    if conn.execute('PRAGMA journal_mode').fetchone()[0].lower() != 'wal':
        conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript(SCHEMA)
    line_cols = {row[1] for row in conn.execute('PRAGMA table_info(lines)')}
    if 'conf_profile' not in line_cols:
        conn.execute('ALTER TABLE lines ADD COLUMN conf_profile TEXT')
    if 'orientation' not in line_cols:
        conn.execute('ALTER TABLE lines ADD COLUMN orientation INTEGER NOT NULL DEFAULT 0')
    if 'needs_ocr' not in line_cols:
        conn.execute('ALTER TABLE lines ADD COLUMN needs_ocr INTEGER NOT NULL DEFAULT 0')
    if 'deleted' not in line_cols:
        conn.execute('ALTER TABLE lines ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')
    if 'check_source' not in line_cols:
        # Existing checks were all made by people or by transcription alignment, and the
        # revision log says which - NULL here means exactly that: not settled by a model.
        conn.execute('ALTER TABLE lines ADD COLUMN check_source TEXT')
    if 'llm_agree_count' not in line_cols:
        conn.execute('ALTER TABLE lines ADD COLUMN llm_agree_count INTEGER NOT NULL DEFAULT 0')
    if 'corrected_by' not in line_cols:
        conn.execute('ALTER TABLE lines ADD COLUMN corrected_by TEXT')
    if 'ocr_model_id' not in line_cols:
        # The model that read this line's text and when, and whether a person drew the
        # line rather than a lines model finding it - what the viewer's provenance shows.
        conn.execute('ALTER TABLE lines ADD COLUMN ocr_model_id INTEGER')
        conn.execute('ALTER TABLE lines ADD COLUMN ocr_run_at TEXT')
        conn.execute('ALTER TABLE lines ADD COLUMN by_hand INTEGER NOT NULL DEFAULT 0')
    el_cols = {row[1] for row in conn.execute('PRAGMA table_info(elements)')}
    if 'kind' not in el_cols:
        conn.execute("ALTER TABLE elements ADD COLUMN kind TEXT NOT NULL DEFAULT 'content'")
    if 'raw_class_name' not in el_cols:
        conn.execute('ALTER TABLE elements ADD COLUMN raw_class_name TEXT')
    if 'deleted' not in el_cols:
        conn.execute('ALTER TABLE elements ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')
    if 'lines_bbox' not in el_cols:
        # Geometry the lines were detected against. NULL means never detected, so a
        # hand-drawn box is stale for free; drift from bbox is what makes it stale later.
        conn.execute('ALTER TABLE elements ADD COLUMN lines_bbox TEXT')
    if 'polygon' not in el_cols:
        conn.execute('ALTER TABLE elements ADD COLUMN polygon TEXT')
    revision_cols = {row[1] for row in conn.execute('PRAGMA table_info(revisions)')}
    if 'client_id' not in revision_cols:
        # The browser tab a write came from, so that tab alone skips its echo on the live
        # feed. NULL for scripts, runners and everything logged before it was recorded.
        conn.execute('ALTER TABLE revisions ADD COLUMN client_id TEXT')
    page_cols = {row[1] for row in conn.execute('PRAGMA table_info(pages)')}
    if 'layout_checked' not in page_cols:
        conn.execute('ALTER TABLE pages ADD COLUMN layout_checked INTEGER NOT NULL DEFAULT 0')
    if 'lines_checked' not in page_cols:
        conn.execute('ALTER TABLE pages ADD COLUMN lines_checked INTEGER NOT NULL DEFAULT 0')
    if 'source_pdf' not in page_cols:
        conn.execute('ALTER TABLE pages ADD COLUMN source_pdf TEXT')
        conn.execute('ALTER TABLE pages ADD COLUMN source_page INTEGER')
    if 'deleted' not in page_cols:
        conn.execute('ALTER TABLE pages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')
    if 'reading_order' not in page_cols:
        # This page's own layout when it differs from the rest of the volume - a plate,
        # a title page, a leaf set in one column in a book set in two. NULL follows the
        # dataset, which is what almost every page does.
        conn.execute('ALTER TABLE pages ADD COLUMN reading_order TEXT')
    if 'source_map' not in page_cols:
        # Provenance for tiles cut from a full map: the job_maps row and the tile's
        # top-left pixel offset (x = row, y = column — old-tool axis convention).
        conn.execute('ALTER TABLE pages ADD COLUMN source_map INTEGER')
        conn.execute('ALTER TABLE pages ADD COLUMN tile_x INTEGER')
        conn.execute('ALTER TABLE pages ADD COLUMN tile_y INTEGER')
    if 'rotation' not in page_cols:
        conn.execute('ALTER TABLE pages ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0')
        conn.execute('ALTER TABLE pages ADD COLUMN origin_file TEXT')
    if 'error' not in page_cols:
        conn.execute('ALTER TABLE pages ADD COLUMN error TEXT')
    if 'layout_model_id' not in page_cols:
        # The layout and lines models that last ran on this page, and when.
        for stage in ('layout', 'lines'):
            conn.execute(f'ALTER TABLE pages ADD COLUMN {stage}_model_id INTEGER REFERENCES models(id)')
            conn.execute(f'ALTER TABLE pages ADD COLUMN {stage}_run_at TEXT')
    region_cols = {row[1] for row in conn.execute('PRAGMA table_info(regions)')}
    if 'kind' not in region_cols:
        # 'polygon' (filled ring + holes) or 'polyline' (open traced boundary line).
        # Existing rows predate line tracing, so the default is exactly right.
        conn.execute("ALTER TABLE regions ADD COLUMN kind TEXT NOT NULL DEFAULT 'polygon'")
    job_cols = {row[1] for row in conn.execute('PRAGMA table_info(jobs)')}
    if 'line_mode' not in job_cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN line_mode TEXT NOT NULL DEFAULT 'per_crop'")
    if 'reading_order' not in job_cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN reading_order TEXT NOT NULL DEFAULT 'auto'")
    if 'auto_redetect' not in job_cols:
        # When 0, phase_relines only re-detects elements a human explicitly asked for
        # (lines_bbox IS NULL), so hand-edited lines survive a re-queue.
        conn.execute('ALTER TABLE jobs ADD COLUMN auto_redetect INTEGER NOT NULL DEFAULT 1')
    if 'layout_shape' not in job_cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN layout_shape TEXT NOT NULL DEFAULT 'box'")
    # The template a dataset's layout classes were copied from, and its reading rules.
    if 'layout_template_id' not in job_cols:
        conn.execute('ALTER TABLE jobs ADD COLUMN layout_template_id INTEGER')
    if 'layout_rules' not in job_cols:
        conn.execute('ALTER TABLE jobs ADD COLUMN layout_rules TEXT')
    # The highest layout class id a dataset removed, so a new class never takes it back.
    if 'max_retired_layout_class_id' not in job_cols:
        conn.execute('ALTER TABLE jobs ADD COLUMN max_retired_layout_class_id INTEGER NOT NULL DEFAULT 0')
    for _col in ('run_layout', 'run_lines', 'run_ocr'):
        if _col not in job_cols:
            conn.execute(f'ALTER TABLE jobs ADD COLUMN {_col} INTEGER NOT NULL DEFAULT 1')
    if 'task' not in job_cols:
        # 'text' (layout/lines/ocr pipeline), 'map_segmentation' (polygon tiles) or
        # 'map_lines' (boundary-line tracing on tiles).
        conn.execute("ALTER TABLE jobs ADD COLUMN task TEXT NOT NULL DEFAULT 'text'")
    if 'run_predict' not in job_cols:
        # Map-segmentation model pre-annotation phase. Off by default: unlike the
        # run_layout/lines/ocr text flags (default 1), most jobs don't predict.
        conn.execute('ALTER TABLE jobs ADD COLUMN run_predict INTEGER NOT NULL DEFAULT 0')
    if 'model_id' not in job_cols:
        # Registry id of the pre-annotation model this map job used (NULL = none/legacy).
        conn.execute('ALTER TABLE jobs ADD COLUMN model_id TEXT')
    if 'run_tile' not in job_cols:
        # Map tiling phase: cut uploaded full maps into squares before ingest.
        conn.execute('ALTER TABLE jobs ADD COLUMN run_tile INTEGER NOT NULL DEFAULT 0')
        conn.execute('ALTER TABLE jobs ADD COLUMN tile_size INTEGER NOT NULL DEFAULT 512')
        conn.execute('ALTER TABLE jobs ADD COLUMN tile_skip_blank INTEGER NOT NULL DEFAULT 1')
    if 'line_width' not in job_cols:
        # Stroke width (px at tile resolution) polylines are rasterized with on mask
        # export. Per job, not per class: the exported masks are one training dataset,
        # which wants a single consistent boundary thickness.
        conn.execute('ALTER TABLE jobs ADD COLUMN line_width INTEGER NOT NULL DEFAULT 3')
    if 'max_retired_class_id' not in job_cols:
        conn.execute('ALTER TABLE jobs ADD COLUMN max_retired_class_id INTEGER NOT NULL DEFAULT 0')
    model_cols = {row[1] for row in conn.execute('PRAGMA table_info(llm_models)')}
    if 'max_tokens' not in model_cols:
        conn.execute('ALTER TABLE llm_models ADD COLUMN max_tokens INTEGER')
    if 'extra_body' not in model_cols:
        conn.execute("ALTER TABLE llm_models ADD COLUMN extra_body TEXT NOT NULL DEFAULT '{}'")
    if 'max_concurrency' not in model_cols:
        conn.execute('ALTER TABLE llm_models ADD COLUMN max_concurrency INTEGER')
    read_cols = {row[1] for row in conn.execute('PRAGMA table_info(llm_reads)')}
    if 'job_id' not in read_cols:
        conn.execute('ALTER TABLE llm_reads ADD COLUMN job_id TEXT')
    if 'prompt_hash' not in read_cols:
        # Readings taken before this predate per-dataset wording; NULL reads as "unknown",
        # which the dataset shows as read under a different prompt.
        conn.execute('ALTER TABLE llm_reads ADD COLUMN prompt_hash TEXT')
    if 'previous_text' not in read_cols:
        conn.execute('ALTER TABLE llm_reads ADD COLUMN previous_text TEXT')
    if 'previous_text' not in {row[1] for row in conn.execute('PRAGMA table_info(gt_reads)')}:
        conn.execute('ALTER TABLE gt_reads ADD COLUMN previous_text TEXT')
    candidate_cols = {row[1] for row in conn.execute('PRAGMA table_info(candidates)')}
    if 'llm_model_id' not in candidate_cols:
        # Which registered language model said it. Entries written before this are OCR or
        # human text, which have no model behind them, so NULL is exactly right for them.
        conn.execute('ALTER TABLE candidates ADD COLUMN llm_model_id INTEGER')
    if 'set_aside_at' not in candidate_cols:
        conn.execute('ALTER TABLE candidates ADD COLUMN set_aside_at INTEGER')
    if 'llm_prompt' not in job_cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN llm_prompt TEXT NOT NULL DEFAULT ''")
    if 'llm_model_ids' not in job_cols:
        # Which language models this dataset is read with, as a JSON list of llm_models ids
        # (the trainings.dataset_job_ids precedent), how many must agree before a line is
        # taken as settled, and whether agreement may check the line off by itself.
        conn.execute("ALTER TABLE jobs ADD COLUMN llm_model_ids TEXT NOT NULL DEFAULT '[]'")
        conn.execute('ALTER TABLE jobs ADD COLUMN llm_consensus_min INTEGER NOT NULL DEFAULT 2')
        conn.execute('ALTER TABLE jobs ADD COLUMN llm_autocheck INTEGER NOT NULL DEFAULT 0')
    if 'llm_consensus_with_ocr' not in job_cols:
        # Off for everything that predates the choice, which is the behaviour those datasets
        # settled their lines under.
        conn.execute('ALTER TABLE jobs ADD COLUMN llm_consensus_with_ocr INTEGER NOT NULL DEFAULT 0')
    if 'group_id' not in job_cols:
        conn.execute('ALTER TABLE jobs ADD COLUMN group_id INTEGER REFERENCES groups(id)')
    if 'ocr_decode' not in job_cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN ocr_decode TEXT NOT NULL DEFAULT 'beam'")
    if 'ocr_convention' not in job_cols:
        # The flags this dataset asks its OCR model for (JSON {name: bool}); empty is the
        # normalized convention every dataset starts with. ocr_convention_read lists the
        # flags the last OCR run could honour, null before any run recorded it.
        conn.execute("ALTER TABLE jobs ADD COLUMN ocr_convention TEXT NOT NULL DEFAULT '{}'")
        conn.execute('ALTER TABLE jobs ADD COLUMN ocr_convention_read TEXT')
    for _col in ('model_layout_id', 'model_lines_id', 'model_ocr_id'):
        if _col not in job_cols:
            conn.execute(f'ALTER TABLE jobs ADD COLUMN {_col} INTEGER REFERENCES models(id)')
    training_cols = {row[1] for row in conn.execute('PRAGMA table_info(trainings)')}
    if 'backend' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN backend TEXT')
        conn.execute('ALTER TABLE trainings ADD COLUMN backend_train_id TEXT')
    if 'gpu_type' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN gpu_type TEXT')
        conn.execute('ALTER TABLE trainings ADD COLUMN gpu_count INTEGER')
    if 'split_strategy' not in training_cols:
        conn.execute("ALTER TABLE trainings ADD COLUMN split_strategy TEXT NOT NULL DEFAULT 'uniform'")
        conn.execute("ALTER TABLE trainings ADD COLUMN valid_job_ids TEXT NOT NULL DEFAULT '[]'")
    if 'batch_size' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN batch_size INTEGER')
    if 'description' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN description TEXT')
    if 'hyperparams' not in training_cols:
        conn.execute("ALTER TABLE trainings ADD COLUMN hyperparams TEXT NOT NULL DEFAULT '{}'")
    if 'human_checked_only' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN human_checked_only INTEGER NOT NULL DEFAULT 0')
    if 'snapshot_progress' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN snapshot_progress TEXT')
    if 'test_job_ids' not in training_cols:
        conn.execute("ALTER TABLE trainings ADD COLUMN test_job_ids TEXT NOT NULL DEFAULT '[]'")
    if 'build_lm' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN build_lm INTEGER NOT NULL DEFAULT 0')
    if 'slurm_account' not in training_cols:
        conn.execute("ALTER TABLE trainings ADD COLUMN slurm_account TEXT NOT NULL DEFAULT ''")
    if 'augmentation' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN augmentation TEXT')
        conn.execute("ALTER TABLE trainings ADD COLUMN augmentation_name TEXT NOT NULL DEFAULT ''")
    if 'attempt' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1')
    if 'preflight_id' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN preflight_id INTEGER REFERENCES training_preflights(id)')
    if 'lm_build' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN lm_build TEXT')
    if 'is_test' not in page_cols:
        _mark_former_test_sets(conn)
    if 'grad_accum_steps' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN grad_accum_steps INTEGER')
        conn.execute('ALTER TABLE trainings ADD COLUMN lr_scale REAL')
        conn.execute('ALTER TABLE trainings ADD COLUMN batch_fallback TEXT')
        conn.execute('ALTER TABLE trainings ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0')
    if 'metric_info' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN metric_info TEXT')
    if 'line_shape' not in training_cols:
        conn.execute('ALTER TABLE trainings ADD COLUMN line_shape TEXT')
        # Before a run could choose, every lines run trained on its polygons as drawn.
        conn.execute("UPDATE trainings SET line_shape = 'polygon' WHERE task = 'lines'")
    for table in ('jobs', 'trainings', 'evaluations'):
        if 'started_at' not in {row[1] for row in conn.execute(f'PRAGMA table_info({table})')}:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN started_at TEXT')
        if 'queued_at' not in {row[1] for row in conn.execute(f'PRAGMA table_info({table})')}:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN queued_at TEXT')
        # Work queues when it is put in the queue, not when it was made: a dataset run again
        # waits behind what was queued before it. One that a restart put back keeps its place.
        conn.execute(f"CREATE TRIGGER IF NOT EXISTS {table}_queued_at AFTER UPDATE OF status ON {table} "
                     "WHEN NEW.status = 'queued' AND OLD.status NOT IN ('queued', 'preparing', 'running') "
                     f"BEGIN UPDATE {table} SET queued_at = datetime('now') WHERE rowid = NEW.rowid; END")
    # 'rescored' named a mode the engine did not run: with an LM configured it did beam
    # search instead, so every job and evaluation recorded the wrong name. Relabel to what
    # actually ran - once, guarded by user_version, or a later deliberate 'rescored' would
    # be flipped back on every boot.
    if conn.execute('PRAGMA user_version').fetchone()[0] < DECODE_RELABEL:
        conn.execute("UPDATE jobs SET ocr_decode = 'beam' WHERE ocr_decode = 'rescored'")
        conn.execute("UPDATE evaluations SET decode = 'beam' WHERE decode = 'rescored'")
        conn.execute(f'PRAGMA user_version = {DECODE_RELABEL}')
    eval_cols = {row[1] for row in conn.execute('PRAGMA table_info(evaluations)')}
    if 'breakdown' not in eval_cols:
        conn.execute('ALTER TABLE evaluations ADD COLUMN breakdown TEXT')
    model_cols = {row[1] for row in conn.execute('PRAGMA table_info(models)')}
    if 'lm_path' not in model_cols:
        conn.execute('ALTER TABLE models ADD COLUMN lm_path TEXT')
        conn.execute('ALTER TABLE models ADD COLUMN lm_dict_path TEXT')
    if 'target_height' not in model_cols:
        conn.execute('ALTER TABLE models ADD COLUMN target_height INTEGER')
        conn.execute('ALTER TABLE models ADD COLUMN max_width INTEGER')
    for column, kind in (('backend', 'TEXT'), ('model_type', 'TEXT'), ('classes', 'TEXT'),
                         ('input_size', 'INTEGER'), ('ref', 'TEXT'), ('conventions', 'TEXT'),
                         ('family_name', 'TEXT')):
        if column not in model_cols:
            conn.execute(f'ALTER TABLE models ADD COLUMN {column} {kind}')
    # 'rescored' named a mode the engine did not run: with an LM configured it did beam
    # search instead, so every job and evaluation recorded the wrong name. Relabel to what
    # actually ran - once, guarded by user_version, or a later deliberate 'rescored' would
    # be flipped back on every boot.
    if conn.execute('PRAGMA user_version').fetchone()[0] < DECODE_RELABEL:
        conn.execute("UPDATE jobs SET ocr_decode = 'beam' WHERE ocr_decode = 'rescored'")
        conn.execute("UPDATE evaluations SET decode = 'beam' WHERE decode = 'rescored'")
        conn.execute(f'PRAGMA user_version = {DECODE_RELABEL}')
    eval_cols = {row[1] for row in conn.execute('PRAGMA table_info(evaluations)')}
    if 'fingerprint' not in eval_cols:
        conn.execute('ALTER TABLE evaluations ADD COLUMN fingerprint TEXT')
    if 'gt_text' not in page_cols:
        conn.execute('ALTER TABLE pages ADD COLUMN gt_text TEXT')
    if 'gt_source' not in page_cols:
        # Pages transcribed before provenance was tracked can only have come from a
        # sidecar .txt - the PDF text layer was not a source yet.
        conn.execute('ALTER TABLE pages ADD COLUMN gt_source TEXT')
        conn.execute("UPDATE pages SET gt_source = 'sidecar' WHERE gt_text IS NOT NULL")
    if 'reference_text' not in page_cols:
        # The corpus span this page is answerable for, with how well the cut is pinned
        # down: which document it came from, how many lines anchored, and how closely.
        conn.execute('ALTER TABLE pages ADD COLUMN reference_text TEXT')
        conn.execute('ALTER TABLE pages ADD COLUMN reference_document TEXT')
        conn.execute('ALTER TABLE pages ADD COLUMN reference_anchors INTEGER NOT NULL DEFAULT 0')
        conn.execute('ALTER TABLE pages ADD COLUMN reference_score REAL NOT NULL DEFAULT 0')
    if 'gt_autocheck' not in job_cols:
        conn.execute('ALTER TABLE jobs ADD COLUMN gt_autocheck INTEGER NOT NULL DEFAULT 0')
    if 'gt_from_pdf' not in job_cols:
        conn.execute('ALTER TABLE jobs ADD COLUMN gt_from_pdf INTEGER NOT NULL DEFAULT 0')
    if 'gt_ordered' not in job_cols:
        conn.execute('ALTER TABLE jobs ADD COLUMN gt_ordered INTEGER NOT NULL DEFAULT 0')
    if 'gt_prompt' not in job_cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN gt_prompt TEXT NOT NULL DEFAULT ''")
    if 'gt_model_ids' not in job_cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN gt_model_ids TEXT NOT NULL DEFAULT '[]'")
    if 'reference_overlap' not in job_cols:
        conn.execute('ALTER TABLE jobs ADD COLUMN reference_overlap INTEGER NOT NULL DEFAULT 2')
    for table, cols in (('lines', line_cols), ('elements', el_cols), ('jobs', job_cols)):
        if 'checked' not in cols:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN checked INTEGER NOT NULL DEFAULT 0')
    # The lines waiting on a re-read, which the queue page counts every few seconds. Built
    # here rather than in SCHEMA because an older database gains needs_ocr just above.
    conn.execute('CREATE INDEX IF NOT EXISTS idx_lines_needs_ocr ON lines(element_id) '
                 'WHERE needs_ocr = 1 AND deleted = 0')
    # Backfill the per-job class vocabulary for map jobs created before job_classes
    # existed, from the legacy default. Idempotent: only jobs with no rows yet.
    # The task list is spelled out rather than imported: ingest imports store, so store
    # cannot import ingest.TILE_TASKS back. Keep the two in sync.
    from app import layout_templates, map_classes
    template_cols = {row[1] for row in conn.execute('PRAGMA table_info(layout_templates)')}
    if 'outside_order' not in template_cols:
        conn.execute("ALTER TABLE layout_templates ADD COLUMN outside_order TEXT NOT NULL DEFAULT 'from_page'")
        conn.execute("UPDATE layout_templates SET outside_order = 'top_to_bottom' WHERE rules = ?",
                     (layout_templates.SCHEMATISMUS_RULES,))
    layout_templates.backfill(conn)
    if 'layout_template_id' not in model_cols:
        conn.execute('ALTER TABLE models ADD COLUMN layout_template_id INTEGER REFERENCES layout_templates(id)')
        # Before templates every layout model was trained on the Schematismus pipeline.
        schematismus = layout_templates.ensure_schematismus(conn)
        if 'reading_rules' in model_cols:
            conn.execute("UPDATE models SET layout_template_id = ? WHERE reading_rules = 'schematismus'",
                         (schematismus,))
        else:
            conn.execute("UPDATE models SET layout_template_id = ? WHERE task = 'layout'", (schematismus,))
    for _row in conn.execute(
            "SELECT id FROM jobs WHERE task IN ('map_segmentation','map_lines') "
            'AND id NOT IN (SELECT DISTINCT job_id FROM job_classes)').fetchall():
        seed_job_classes(conn, _row['id'], map_classes.classes_payload())
    # A correction from before corrected_by was kept names nobody, and nobody reads as a
    # person's - so the eraser spared every consensus and alignment fill-in from back
    # then. Every writer logged the row right after writing it, so the newest revision
    # carrying the row's text was logged by whoever wrote that text - except a realign,
    # which carried somebody else's correction onto a re-detected line and logged it under
    # its own name. A correction only a carrier or no revision carries stays nobody's.
    if conn.execute('PRAGMA user_version').fetchone()[0] < CORRECTED_BY_BACKFILL:
        conn.execute(
            'UPDATE lines SET corrected_by = ('
            "SELECT author FROM revisions WHERE target_type = 'line' AND target_id = lines.id "
            "AND json_extract(snapshot, '$.corrected_text') = lines.corrected_text "
            "AND author NOT LIKE 'realign:%' "
            'ORDER BY id DESC LIMIT 1) '
            'WHERE corrected_text IS NOT NULL AND corrected_by IS NULL')
        conn.execute(f'PRAGMA user_version = {CORRECTED_BY_BACKFILL}')
    # Nothing recorded which model read a page before the columns above, so every page
    # already read is credited to its dataset's model as it stands now. A
    # line a person created is known from its first revision.
    if conn.execute('PRAGMA user_version').fetchone()[0] < PROVENANCE_BACKFILL:
        for stage, done in (('layout', 'SELECT 1 FROM elements e WHERE e.page_id = pages.id'),
                            ('lines', 'SELECT 1 FROM elements e JOIN lines l ON l.element_id = e.id '
                                      'WHERE e.page_id = pages.id')):
            conn.execute(
                f'UPDATE pages SET {stage}_model_id = ('
                f'SELECT COALESCE(j.model_{stage}_id, (SELECT id FROM models WHERE task = ? '
                'AND is_default = 1 ORDER BY id LIMIT 1)) FROM jobs j WHERE j.id = pages.job_id) '
                f'WHERE {stage}_model_id IS NULL AND EXISTS ({done}) '
                "AND job_id IN (SELECT id FROM jobs WHERE task = 'text')", (stage,))
        conn.execute(
            'UPDATE lines SET ocr_model_id = ('
            "SELECT COALESCE(j.model_ocr_id, (SELECT id FROM models WHERE task = 'ocr' "
            'AND is_default = 1 ORDER BY id LIMIT 1)) FROM elements e JOIN pages p ON e.page_id = p.id '
            'JOIN jobs j ON p.job_id = j.id WHERE e.id = lines.element_id) '
            'WHERE ocr_model_id IS NULL AND text IS NOT NULL')
        conn.execute(
            'UPDATE lines SET by_hand = 1 WHERE id IN ('
            "SELECT target_id FROM revisions r WHERE target_type = 'line' AND action = 'create' "
            f'AND {person_author_sql("r.author")})')
        conn.execute(f'PRAGMA user_version = {PROVENANCE_BACKFILL}')
    # DeepOCR reads decomposed (an accent as its own code point) and nothing composed what
    # it read, so stored text mixed both forms of the same word.
    if conn.execute('PRAGMA user_version').fetchone()[0] < TEXT_COMPOSED:
        conn.create_function('nfc', 1, lambda text: unicodedata.normalize('NFC', text) if text else text,
                             deterministic=True)
        for column in ('text', 'corrected_text'):
            conn.execute(f'UPDATE lines SET {column} = nfc({column}) WHERE {column} != nfc({column})')
        conn.execute(f'PRAGMA user_version = {TEXT_COMPOSED}')
    conn.commit()
    return conn


def snapshot_element(row: sqlite3.Row) -> dict:
    return {'id': row['id'], 'page_id': row['page_id'], 'order_idx': row['order_idx'],
            'class_name': row['class_name'], 'raw_class_name': row['raw_class_name'],
            'bbox': json.loads(row['bbox']), 'conf': row['conf'], 'kind': row['kind'],
            'checked': bool(row['checked']), 'deleted': bool(row['deleted']),
            'lines_bbox': json.loads(row['lines_bbox']) if row['lines_bbox'] else None,
            'polygon': json.loads(row['polygon']) if row['polygon'] else None}


def snapshot_line(row: sqlite3.Row) -> dict:
    # conf_profile is omitted: per-character floats, never human-edited.
    return {'id': row['id'], 'element_id': row['element_id'], 'order_idx': row['order_idx'],
            'polygon': json.loads(row['polygon']), 'text': row['text'],
            'corrected_text': row['corrected_text'], 'corrected_by': row['corrected_by'],
            'confidence': row['confidence'],
            'checked': bool(row['checked']), 'deleted': bool(row['deleted']),
            'orientation': row['orientation'], 'check_source': row['check_source']}


def snapshot_region(row: sqlite3.Row) -> dict:
    return {'id': row['id'], 'page_id': row['page_id'], 'order_idx': row['order_idx'],
            'class_id': row['class_id'], 'points': json.loads(row['points']),
            'holes': json.loads(row['holes']), 'kind': row['kind'],
            'checked': bool(row['checked']), 'deleted': bool(row['deleted'])}


# The tab whose request is being served, set once per request by the web layer so that
# every revision the request logs carries it without each caller passing it down.
revision_client: ContextVar[str | None] = ContextVar('revision_client', default=None)


def log_revision(conn: sqlite3.Connection, target_type: str, target_id: int, job_id: str,
                 author: str, action: str, snapshot: dict):
    """Append one revision. Never commits - the caller's transaction must carry
    both the materialized write and this log entry."""
    conn.execute('INSERT INTO revisions (target_type, target_id, job_id, author, action, snapshot, client_id) '
                 'VALUES (?,?,?,?,?,?,?)',
                 (target_type, target_id, job_id, author, action, json.dumps(snapshot),
                  revision_client.get()))


def log_element(conn: sqlite3.Connection, element_id: int, author: str, action: str):
    """Snapshot an element as it now stands. Call after the UPDATE, so the newest
    revision always equals the materialized row."""
    row = conn.execute(
        'SELECT e.*, p.job_id FROM elements e JOIN pages p ON e.page_id = p.id WHERE e.id = ?',
        (element_id,)).fetchone()
    if row is not None:
        log_revision(conn, 'element', element_id, row['job_id'], author, action, snapshot_element(row))


def log_line(conn: sqlite3.Connection, line_id: int, author: str, action: str):
    row = conn.execute(
        'SELECT l.*, p.job_id FROM lines l JOIN elements e ON l.element_id = e.id '
        'JOIN pages p ON e.page_id = p.id WHERE l.id = ?', (line_id,)).fetchone()
    if row is not None:
        log_revision(conn, 'line', line_id, row['job_id'], author, action, snapshot_line(row))


def check_line_as_person(conn: sqlite3.Connection, line_id: int, checked: bool) -> None:
    """A person's check or un-check. Either way the line stops being machine-settled: a
    check makes it theirs, and an unchecked line has no checker to name. Only a check
    answers a review flag; an un-check leaves the line waiting in the queue."""
    conn.execute('UPDATE lines SET checked = ?, check_source = NULL WHERE id = ?',
                 (int(checked), line_id))
    if checked:
        conn.execute('DELETE FROM review_flags WHERE line_id = ?', (line_id,))


def log_region(conn: sqlite3.Connection, region_id: int, author: str, action: str):
    row = conn.execute(
        'SELECT r.*, p.job_id FROM regions r JOIN pages p ON r.page_id = p.id WHERE r.id = ?',
        (region_id,)).fetchone()
    if row is not None:
        log_revision(conn, 'region', region_id, row['job_id'], author, action, snapshot_region(row))


# The newest revision id doubles as an edit token: a client sends back the one it
# loaded, and a save is refused when someone else has logged a newer one since.
# 0 stands for "never logged", so a row the pipeline wrote and nobody touched has a
# token too.
def latest_revisions(conn: sqlite3.Connection, target_type: str, target_ids) -> dict[int, int]:
    ids = list(target_ids)
    if not ids:
        return {}
    marks = ','.join('?' * len(ids))
    rows = conn.execute(
        f'SELECT target_id, MAX(id) AS revision FROM revisions '
        f'WHERE target_type = ? AND target_id IN ({marks}) GROUP BY target_id', (target_type, *ids))
    latest = {target_id: 0 for target_id in ids}
    latest.update({r['target_id']: r['revision'] for r in rows})
    return latest


def latest_revision(conn: sqlite3.Connection, target_type: str, target_id: int) -> int:
    return latest_revisions(conn, target_type, [target_id])[target_id]


def revision_mark(conn: sqlite3.Connection) -> int:
    """The newest revision id anywhere. Read once before a write and once before its
    commit, the pair brackets exactly the revisions that write logged - the span a
    client hands back to take the edit back."""
    return conn.execute('SELECT MAX(id) AS id FROM revisions').fetchone()['id'] or 0


def write_lock(conn: sqlite3.Connection) -> None:
    """Take the database's write lock now rather than at the first write, so what an
    edit checks first (a revision token, a foreign edit) cannot change before it writes."""
    if not conn.in_transaction:
        conn.execute('BEGIN IMMEDIATE')


def begin_span(conn: sqlite3.Connection) -> int:
    """Take the write lock, then read the mark an edit's span starts from. Read outside a
    write, another connection's revision could land between the mark and the edit's own
    first write, and Undo would take it back too."""
    write_lock(conn)
    return revision_mark(conn)


def end_span(conn: sqlite3.Connection, mark: int) -> dict:
    """The span from begin_span's mark to this edit's last revision, read before commit."""
    return {'from': mark, 'to': revision_mark(conn)}


# Authors that are not people: their writes never stand in the way of someone taking
# an edit back, and their reads are not what a revert is protecting. Taking over an
# export writes rows the same way, so the import is provenance too.
MACHINE_AUTHORS = ('model:', 'llm:', 'align:', 'realign:', 'system:', 'import:')


def is_person(author: str) -> bool:
    return not author.startswith(MACHINE_AUTHORS)


def person_author_sql(column: str = 'author') -> str:
    """is_person as a WHERE condition, for counting people's revisions in SQL."""
    return ' AND '.join(f"{column} NOT LIKE '{prefix}%'" for prefix in MACHINE_AUTHORS)


_LOG = {'line': log_line, 'element': log_element, 'region': log_region}


def ensure_origin(conn: sqlite3.Connection, target_type: str, target_id: int, author: str) -> None:
    """A row the pipeline wrote has no history. Snapshot it as it stands before the
    first logged write, or that write could never be taken back."""
    if latest_revision(conn, target_type, target_id) == 0:
        _LOG[target_type](conn, target_id, author, 'origin')


def job_revision(conn: sqlite3.Connection, job_id: str) -> int:
    """The newest revision anywhere in a dataset: where a live page starts listening."""
    row = conn.execute('SELECT MAX(id) AS revision FROM revisions WHERE job_id = ?', (job_id,)).fetchone()
    return row['revision'] or 0


def page_revisions(conn: sqlite3.Connection, page_id: int, job_id: str, after: int,
                   upto: int | None = None) -> list[dict]:
    """Revisions newer than `after` (and, when given, no newer than `upto`) that touch
    this page - its lines, elements, regions or the page row itself. An origin is a
    record of how a row stood, not a change to it, so it is never listed."""
    upper = 'AND r.id <= ? ' if upto is not None else ''
    params = [job_id, after] + ([upto] if upto is not None else []) + [page_id] * 4
    rows = conn.execute(
        'SELECT r.id AS revision, r.target_type AS kind, r.target_id AS id, r.author, r.action, '
        'r.client_id AS client '
        f'FROM revisions r WHERE r.job_id = ? AND r.id > ? {upper}'
        "AND r.action != 'origin' AND ("
        "  (r.target_type = 'line' AND r.target_id IN ("
        '     SELECT l.id FROM lines l JOIN elements e ON l.element_id = e.id WHERE e.page_id = ?))'
        "  OR (r.target_type = 'element' AND r.target_id IN (SELECT id FROM elements WHERE page_id = ?))"
        "  OR (r.target_type = 'region' AND r.target_id IN (SELECT id FROM regions WHERE page_id = ?))"
        "  OR (r.target_type = 'page' AND r.target_id = ?)) "
        'ORDER BY r.id', params).fetchall()
    return [dict(r) for r in rows]


def page_changes_since(conn: sqlite3.Connection, page_id: int, job_id: str,
                       since: int) -> tuple[int, list[dict]]:
    """Revisions newer than `since` that touch this page, and the dataset's newest
    revision id, which is the cursor to ask from next time even when none of the new
    revisions concerned this page."""
    newest = job_revision(conn, job_id)
    if newest <= since:
        return since, []
    return newest, page_revisions(conn, page_id, job_id, after=since)


# --- per-job map class vocabulary -------------------------------------------

def seed_job_classes(conn: sqlite3.Connection, job_id: str, classes: list[dict]):
    """Insert a job's initial vocabulary from a classes_payload list. No commit.
    INSERT OR IGNORE so re-seeding an already-seeded job is a no-op (backfill safety)."""
    for c in classes:
        conn.execute(
            'INSERT OR IGNORE INTO job_classes (job_id, class_id, name, color, priority_rank) '
            'VALUES (?,?,?,?,?)',
            (job_id, c['id'], c['name'], json.dumps(c['color']), c['priority']))


def job_classes(conn: sqlite3.Connection, job_id: str) -> list[dict]:
    """The job's vocabulary in classes_payload form, ordered by class id."""
    return [
        {'id': r['class_id'], 'name': r['name'], 'color': json.loads(r['color']),
         'priority': r['priority_rank']}
        for r in conn.execute(
            'SELECT class_id, name, color, priority_rank FROM job_classes '
            'WHERE job_id = ? ORDER BY class_id', (job_id,))]


def job_class_names(conn: sqlite3.Connection, job_id: str) -> dict:
    return {r['class_id']: r['name'] for r in conn.execute(
        'SELECT class_id, name FROM job_classes WHERE job_id = ?', (job_id,))}


def job_row_to_dict(row: sqlite3.Row) -> dict:
    job = dict(row)
    job['counters'] = json.loads(job.get('counters') or '{}')
    job['checked'] = bool(job.get('checked'))
    job['task'] = job.get('task') or 'text'
    job['model_id'] = job.get('model_id')
    job['auto_redetect'] = bool(job.get('auto_redetect', 1))
    for phase in ('run_layout', 'run_lines', 'run_ocr'):
        job[phase] = bool(job.get(phase, 1))
    job['run_predict'] = bool(job.get('run_predict', 0))
    job['run_tile'] = bool(job.get('run_tile', 0))
    job['tile_size'] = int(job.get('tile_size') or 512)
    job['tile_skip_blank'] = bool(job.get('tile_skip_blank', 1))
    job['line_width'] = int(job.get('line_width') or 3)
    job['llm_model_ids'] = json.loads(job.get('llm_model_ids') or '[]')
    job['gt_model_ids'] = json.loads(job.get('gt_model_ids') or '[]')
    job['ocr_convention'] = json.loads(job.get('ocr_convention') or '{}')
    read = job.get('ocr_convention_read')
    job['ocr_convention_read'] = json.loads(read) if read is not None else None
    job['llm_consensus_min'] = int(job.get('llm_consensus_min') or 2)
    job['llm_autocheck'] = bool(job.get('llm_autocheck', 0))
    job['llm_consensus_with_ocr'] = bool(job.get('llm_consensus_with_ocr', 0))
    job['gt_autocheck'] = bool(job.get('gt_autocheck', 0))
    job['gt_ordered'] = bool(job.get('gt_ordered', 0))
    job['new_pages_test'] = bool(job.get('new_pages_test', 0))
    job.pop('pid', None)
    return job


def note_page_model(conn: sqlite3.Connection, page_id: int, stage: str, model_id: int | None) -> None:
    """Credit a page's layout or lines to the model that just produced them."""
    assert stage in ('layout', 'lines')
    conn.execute(f"UPDATE pages SET {stage}_model_id = ?, {stage}_run_at = datetime('now') WHERE id = ?",
                 (model_id, page_id))


def note_convention_read(conn: sqlite3.Connection, job_id: str, honoured: list[str]) -> None:
    conn.execute('UPDATE jobs SET ocr_convention_read = ? WHERE id = ?', (json.dumps(honoured), job_id))
    conn.commit()


def get_job(conn: sqlite3.Connection, job_id: str) -> dict | None:
    row = conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return job_row_to_dict(row) if row else None


def enable_ocr_phase(conn: sqlite3.Connection, job_id: str):
    """Make a dataset able to honour a re-read request. An imported dataset arrives with
    every phase off, so a flagged line would spin forever: nothing ever ran an OCR phase.
    With no line detection to advance them, the pages also have to reach the status
    phase_ocr selects."""
    job = get_job(conn, job_id)
    if job is None or job['run_ocr']:
        return
    conn.execute('UPDATE jobs SET run_ocr = 1 WHERE id = ?', (job_id,))
    if not job['run_lines']:
        conn.execute("UPDATE pages SET status = 'lines_done' WHERE job_id = ? "
                     "AND deleted = 0 AND status = 'layout_done'", (job_id,))


def enable_phases(conn: sqlite3.Connection, job_id: str, layout=False, lines=False, ocr=False):
    """Switch on phases a dataset was created without. The flags are set once at creation,
    so a dataset built with detection off - or one imported with annotations already on it
    - could never be given any of it afterwards."""
    columns = [c for c, wanted in (('run_layout', layout), ('run_lines', lines), ('run_ocr', ocr))
               if wanted]
    for column in columns:
        conn.execute(f'UPDATE jobs SET {column} = 1 WHERE id = ?', (job_id,))


def update_counters(conn: sqlite3.Connection, job_id: str, commit: bool = True, **updates):
    row = conn.execute('SELECT counters FROM jobs WHERE id = ?', (job_id,)).fetchone()
    counters = json.loads(row['counters'] or '{}') if row else {}
    counters.update(updates)
    conn.execute('UPDATE jobs SET counters = ? WHERE id = ?', (json.dumps(counters), job_id))
    if commit:
        conn.commit()


def taken_hashes(conn: sqlite3.Connection, table: str, job_id: str) -> set[str]:
    """Content hashes already claimed in this job, for ingest deduplication. Deleted
    rows never claim one: uploading a page again after deleting it has to ingest
    normally, instead of landing as a 'duplicate' that is never sized, never
    rendered and excluded from every export. Nor does a duplicate, which only points
    at content another row holds - once that row is deleted, nothing holds it."""
    if table not in ('pages', 'job_maps'):
        raise ValueError(f'not a dedupable table: {table}')
    return {row['content_hash'] for row in conn.execute(
        f'SELECT content_hash FROM {table} '  # noqa: S608 - literal, checked above
        "WHERE job_id = ? AND deleted = 0 AND status != 'duplicate' "
        'AND content_hash IS NOT NULL', (job_id,))}


def recount_pages(conn: sqlite3.Connection, job_id: str, commit: bool = True) -> int:
    """Recompute every counter with deleted pages excluded. All of them are page
    scoped, so deleting a page stales them all at once - recomputing only
    pages_total would leave the bars reading e.g. 4/2. A duplicate is no work, so it is
    out of every counter too, or a dataset holding one could never reach 100%."""
    one = lambda sql: conn.execute(sql, (job_id,)).fetchone()['c']
    pages = f'FROM pages WHERE job_id = ? AND {caches.counted_page()}'
    els = ('FROM elements e JOIN pages p ON e.page_id = p.id '
           "WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 AND e.kind = 'content'")
    lines = ('FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
             'WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 AND l.deleted = 0')
    total = one(f'SELECT COUNT(*) c {pages}')
    update_counters(
        conn, job_id, commit,
        pages_total=total,
        pages_ingested=one(f"SELECT COUNT(*) c {pages} AND status != 'pending'"),
        pages_layout_done=one(f"SELECT COUNT(*) c {pages} AND status IN ('layout_done','lines_done','done')"),
        elements_total=one(f'SELECT COUNT(*) c {els}'),
        elements_lines_done=one(f"SELECT COUNT(*) c {els} AND p.status IN ('lines_done','done')"),
        lines_total=one(f'SELECT COUNT(*) c {lines}'),
        lines_ocr_done=one(f'SELECT COUNT(*) c {lines} AND l.text IS NOT NULL'))
    # Map jobs have no elements/lines; a predicted tile reaches status='done'. Tiling
    # jobs also track source maps cut so far (maps_tiled counts done + duplicate).
    task = conn.execute('SELECT task FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if task and task['task'] in ('map_segmentation', 'map_lines'):  # ingest.TILE_TASKS
        jm = 'FROM job_maps WHERE job_id = ? AND deleted = 0'
        update_counters(conn, job_id, commit,
                        pages_predicted=one(f"SELECT COUNT(*) c {pages} AND status = 'done'"),
                        maps_total=one(f'SELECT COUNT(*) c {jm}'),
                        maps_tiled=one(f"SELECT COUNT(*) c {jm} AND status != 'pending'"))
    return total


# Stamps started_at as work leaves the queue - into preparing (a training cutting its
# snapshot) or running - and keeps it through every later phase, so a cluster run counts
# from its preparation, not from Slurm picking it up. SQLite reads the old status here.
STARTED_AT_UPDATE = ("started_at = CASE WHEN ? IN ('preparing', 'running') AND status NOT IN ('preparing', 'running') "
                     "THEN datetime('now') ELSE started_at END")


def state_update(fields: dict) -> tuple[str, list]:
    """The SET clause and its parameters for these columns, stamping started_at when a
    status is among them."""
    sets = [f'{key} = ?' for key in fields]
    params = list(fields.values())
    if 'status' in fields:
        sets.append(STARTED_AT_UPDATE)
        params.append(fields['status'])
    return ', '.join(sets), params


def set_job_state(conn: sqlite3.Connection, job_id: str, status=None, phase=None, error=None, pid=None):
    fields = {col: val for col, val in (('status', status), ('phase', phase), ('error', error), ('pid', pid))
              if val is not None}
    if fields:
        sets, params = state_update(fields)
        conn.execute(f'UPDATE jobs SET {sets} WHERE id = ?', (*params, job_id))
        conn.commit()
