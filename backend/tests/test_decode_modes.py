"""Which decode a run actually performs. The mode used to be decided inside the engine
by whether an LM happened to be configured, so every model carrying one ran beam search
while the job, the evaluation and the UI all said 'rescored'.
"""
import pytest

from app import decode


def test_the_three_modes_are_offered():
    assert decode.OCR_DECODES == ('beam', 'rescored', 'greedy')


@pytest.mark.parametrize('asked', ['greedy', 'beam', 'rescored'])
def test_a_mode_is_performed_as_asked(asked):
    assert decode.resolve(asked, lm_on=True, use_decoder=True) == asked


def test_beam_without_an_lm_falls_back_rather_than_decoding_blind():
    # torchaudio needs a dictionary to fuse; without one there is no beam to run.
    assert decode.resolve('beam', lm_on=False, use_decoder=True) == 'rescored'
    assert decode.resolve('beam', lm_on=False, use_decoder=False) == 'greedy'


def test_rescoring_without_a_decoder_head_falls_back():
    assert decode.resolve('rescored', lm_on=True, use_decoder=False) == 'beam'
    assert decode.resolve('rescored', lm_on=False, use_decoder=False) == 'greedy'


def test_greedy_is_never_overridden():
    assert decode.resolve('greedy', lm_on=True, use_decoder=True) == 'greedy'


class TestEveryDecodeIsScored:
    """One score per model hid that the decodes disagree: on Kurrent handwriting the
    decoder rerank beat the LM beam by 1.4 CER points, which a single number could
    never show.
    """

    def test_a_result_is_scored_in_every_mode(self, tmp_path):
        from app import evaluator, store
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO models (id, task, name, source, checkpoint) "
                     "VALUES (7, 'ocr', 'new', 'trained', '/m.pt')")
        conn.execute("INSERT INTO trainings (id, task, name, target, owner) "
                     "VALUES (3, 'ocr', 't', 'slurm', 'root')")
        conn.commit()
        evaluator.create_result_eval(conn, {'id': 3, 'owner': 'root'}, 7)
        modes = [r[0] for r in conn.execute(
            'SELECT decode FROM evaluations WHERE model_id = 7 ORDER BY decode')]
        assert modes == sorted(decode.OCR_DECODES)
        conn.close()


class TestDomainLanguageModel:
    """A run can have its backend fit a KenLM to its own ground truth. The general union LM
    cost 1.4 CER points on Kurrent handwriting, because it was built for material this
    dataset is not. How the build went is kept with the run.
    """

    def _training(self, tmp_path, build_lm):
        from app import store
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO trainings (id, task, name, target, build_lm) "
                     "VALUES (4, 'ocr', 't', 'slurm', ?)", (build_lm,))
        conn.commit()
        (tmp_path / 'trainings' / '4' / 'snapshot' / 'train').mkdir(parents=True)
        return conn

    @pytest.mark.parametrize('build_lm, status, artefacts, reported', [
        (0, 'done', None, None),
        (1, 'preparing', None, None),
        (1, 'preparing', (), None),
        (1, 'done', (), 'failed'),
        (1, 'error', (), 'failed'),
        (1, 'done', ('domain.bin', 'domain.dict'), 'built'),
        (1, 'done', ('domain.bin',), 'failed'),
    ])
    def test_the_run_reports_how_its_build_went(self, tmp_path, monkeypatch, build_lm, status,
                                                 artefacts, reported):
        from app import trainer
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
        conn = self._training(tmp_path, build_lm=build_lm)
        conn.execute('UPDATE trainings SET status = ? WHERE id = 4', (status,))
        conn.commit()
        if artefacts is not None:
            lm_dir = tmp_path / 'trainings' / '4' / 'lm'
            lm_dir.mkdir(parents=True)
            for name in artefacts:
                (lm_dir / name).write_bytes(b'lm')
        row = conn.execute('SELECT * FROM trainings WHERE id = 4').fetchone()
        assert trainer.training_payload(row)['lm_build'] == reported
        conn.close()

    def _stored(self, conn):
        return conn.execute('SELECT lm_build FROM trainings WHERE id = 4').fetchone()[0]

    def test_the_kept_outcome_wins_over_the_folder(self, tmp_path, monkeypatch):
        """Once stored, what the build said is the answer, even with no folder left."""
        from app import trainer
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
        conn = self._training(tmp_path, build_lm=1)
        trainer.set_state_for_attempt(conn, 4, 1, lm_build='built')
        conn.execute("UPDATE trainings SET status = 'done' WHERE id = 4")
        conn.commit()

        row = conn.execute('SELECT * FROM trainings WHERE id = 4').fetchone()
        assert trainer.training_payload(row)['lm_build'] == 'built'
        conn.close()

    def test_an_outcome_reported_by_a_replaced_attempt_is_not_kept(self, tmp_path, monkeypatch):
        from app import trainer
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
        conn = self._training(tmp_path, build_lm=1)
        conn.execute('UPDATE trainings SET attempt = 2 WHERE id = 4')
        conn.commit()

        trainer.set_state_for_attempt(conn, 4, 1, lm_build='failed')

        assert self._stored(conn) is None
        conn.close()

    def test_a_retry_forgets_the_outcome_of_the_attempt_before(self, tmp_path, monkeypatch):
        from app import trainer
        monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
        conn = self._training(tmp_path, build_lm=1)
        trainer.set_state_for_attempt(conn, 4, 1, lm_build='failed')
        conn.execute("UPDATE trainings SET status = 'error' WHERE id = 4")
        conn.commit()

        assert trainer.claim_retry(conn, 4) == 2

        assert self._stored(conn) is None
        conn.close()


def test_a_run_with_its_own_lm_registers_that_one(tmp_path, monkeypatch):
    """The base's LM was built for other corpora; the run's own is fitted to this text."""
    from app import registry, store, trainer
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path)
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO models (id, task, name, source, checkpoint, lm_path, lm_dict_path) "
                 "VALUES (1, 'ocr', 'base', 'builtin', '/b.pt', '/general.bin', '/general.dict')")
    conn.execute("INSERT INTO trainings (id, task, name, owner, target, base_model_id, build_lm) "
                 "VALUES (6, 'ocr', 'fit', 'root', 'local', 1, 1)")
    conn.commit()
    out = tmp_path / '6' / 'output'
    out.mkdir(parents=True)
    (out / trainer.CHECKPOINT_NAME).write_bytes(b'ckpt')
    lm = tmp_path / '6' / 'lm'
    lm.mkdir(parents=True)
    (lm / 'domain.bin').write_bytes(b'lm')
    (lm / 'domain.dict').write_text('t')

    model_id = trainer.register_result(conn, trainer.get_training(conn, 6), out)
    row = registry.get_model(conn, model_id)
    assert (row['lm_path'], row['lm_dict_path']) == (str(lm / 'domain.bin'), str(lm / 'domain.dict'))
    conn.close()
