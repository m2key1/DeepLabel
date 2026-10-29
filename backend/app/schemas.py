from pydantic import BaseModel

# Documentation-only shapes for the endpoints a script actually consumes. They are
# attached through `responses=`, never `response_model=`: FastAPI would otherwise filter
# every payload through them, and these describe the guaranteed fields rather than the
# full row - a dataset also carries whatever columns the jobs table has grown.


class Counters(BaseModel):
    pages_total: int
    pages_ingested: int
    pages_layout_done: int
    elements_total: int
    lines_total: int
    lines_ocr_done: int


class DataUse(BaseModel):
    """What the owner allows a dataset's data to be used for."""

    training: bool
    test: bool
    external_llm: bool
    export: bool


class JobSummary(BaseModel):
    """A dataset. Additional fields may be present."""

    id: str
    name: str
    owner: str
    status: str
    phase: str | None
    task: str
    counters: Counters
    created_at: str
    shared_with: list[str]
    error: str | None
    run_layout: bool
    run_lines: bool
    run_ocr: bool
    model_layout_id: int | None
    model_lines_id: int | None
    model_ocr_id: int | None
    ocr_decode: str
    ocr_convention: dict[str, bool]
    ocr_convention_read: list[str] | None
    data_use: DataUse
    layout_shape: str = 'box'


class PageSummary(BaseModel):
    id: int
    idx: int
    filename: str
    width: int | None
    height: int | None
    status: str
    layout_checked: bool
    lines_checked: bool
    deleted: bool
    min_confidence: float | None
    avg_confidence: float | None
    elements_total: int
    elements_checked: int


class JobDetail(JobSummary):
    """One dataset with its pages."""

    pages: list[PageSummary]
    pages_checked: int


class ModelEntry(BaseModel):
    id: int
    task: str
    name: str
    checkpoint: str
    is_default: bool
    archived: bool
    notes: str | None
    created_at: str


class ModelList(BaseModel):
    models: list[ModelEntry]
