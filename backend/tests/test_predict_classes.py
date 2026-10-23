"""Which classes a predict run extracts, and what the resulting regions are tagged as.

Line jobs are the subtle case: their vocabulary is one class, so the polygon job's
"intersect with the job's classes" rule would extract only that id's surfaces and silently
lose the rest.
"""
from app import map_classes
from app.jobs import predict_classes

MODEL = {1, 2, 3, 4, 5}  # buildings, forests, rivers, roads, urban


class TestPolygonJobs:
    def test_intersects_so_a_deleted_class_is_not_reintroduced(self):
        assert predict_classes('map_segmentation', [1, 3], MODEL) == ([1, 3], None)

    def test_falls_back_to_the_model_when_nothing_intersects(self):
        assert predict_classes('map_segmentation', [9], MODEL) == ([1, 2, 3, 4, 5], None)

    def test_never_merges(self):
        assert predict_classes('map_segmentation', [1, 2], MODEL)[1] is None


class TestLineJobs:
    def test_extracts_every_model_surface_not_just_its_own_class_id(self):
        # The regression this guards: intersecting [1] with the model would outline only
        # buildings and drop forests/rivers/roads/urban.
        class_ids, merge = predict_classes('map_lines', [map_classes.LINE_CLASS_ID], MODEL)
        assert class_ids == [1, 2, 3, 4, 5]
        assert merge == map_classes.LINE_CLASS_ID

    def test_merges_into_the_jobs_first_drawable_class(self):
        # A job whose 'edge lines' class was replaced by a differently-numbered one.
        assert predict_classes('map_lines', [7], MODEL) == ([1, 2, 3, 4, 5], 7)

    def test_extra_line_classes_still_merge_into_the_first(self):
        # Adding finer line types by hand does not change where predictions land; a human
        # reassigns them afterwards.
        assert predict_classes('map_lines', [1, 6, 8], MODEL)[1] == 1

    def test_falls_back_to_the_default_class_when_the_job_has_none(self):
        assert predict_classes('map_lines', [], MODEL)[1] == map_classes.LINE_CLASS_ID


class TestLineSeedVocabulary:
    def test_is_background_plus_one_drawable_class(self):
        payload = map_classes.line_classes_payload()
        assert [c['id'] for c in payload] == [0, map_classes.LINE_CLASS_ID]
        assert payload[1]['name'] == map_classes.LINE_CLASS_NAME

    def test_background_keeps_id_zero_so_export_and_deletion_rules_hold(self):
        assert payload_by_id()[0]['name'] == map_classes.BACKGROUND_NAME

    def test_the_drawable_class_outranks_background(self):
        by_id = payload_by_id()
        assert by_id[map_classes.LINE_CLASS_ID]['priority'] < by_id[0]['priority']

    def test_segmentation_vocabulary_is_untouched(self):
        names = [c['name'] for c in map_classes.classes_payload()]
        assert names == ['background', 'buildings', 'forests', 'rivers', 'roads', 'urban']


def payload_by_id():
    return {c['id']: c for c in map_classes.line_classes_payload()}
