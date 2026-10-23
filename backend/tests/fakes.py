class FakeTrainer:
    """A model backend that trains every task, as remote_training.training_backend hands
    it out: its name, its cluster image and its train declaration (6.2)."""

    def __init__(self, train: dict | None = None):
        self.backend = type('Configured', (), {'name': 'trainer', 'cluster_image': '/images/trainer.sqsh'})()
        self.train = {
            'tasks': ['ocr', 'lines', 'layout'], 'outputs': ['weights', 'lm', 'lm_dict'],
            'tunables': [
                {'key': 'learning_rate', 'kind': 'float', 'above': 0},
                {'key': 'warmup_epochs', 'kind': 'float', 'min': 0},
                {'key': 'patience', 'kind': 'int', 'min': 1},
                {'key': 'freeze_backbone', 'kind': 'bool'},
            ],
            **(train or {})}

    def info(self) -> dict:
        return {'train': self.train, 'gpu': {}}


def seed_defaults(conn) -> None:
    """One default model per text task, as an install from before the backends had them:
    the layout one read by the Schematismus template."""
    from app import layout_templates
    template = layout_templates.ensure_schematismus(conn)
    conn.executemany(
        "INSERT INTO models (task, name, source, checkpoint, is_default, layout_template_id) "
        "VALUES (?, ?, 'builtin', ?, 1, ?)",
        [('layout', 'RF-DETR 2XL', '/models/rfdetr.pth', template),
         ('lines', 'DB ppocrv6', '/models/db.pth', None),
         ('ocr', 'DeepOCR', '/models/deepocr.ckpt', None)])
    conn.commit()
