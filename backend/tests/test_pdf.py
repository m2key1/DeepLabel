"""The PDF toolchain is poppler, invoked as subprocesses. These pin the two things
callers depend on: a missing binary is a clear PdfError rather than an escaping
FileNotFoundError, and page_texts returns one entry per page of the text layer.
"""
import pytest

from app import pdf
from tests.pdfs import text_pdf

PAGES = [
    ['Pfarre Wien', 'Kaplan Huber', 'Dechant Mayer'],
    ['Pfarre Graz', 'Kaplan Gruber'],
]


@pytest.fixture
def sample(tmp_path):
    path = tmp_path / 'schematismus.pdf'
    path.write_bytes(text_pdf(PAGES))
    return path


class TestMissingPoppler:
    def test_probe_reports_the_missing_binary_instead_of_crashing(self, tmp_path, monkeypatch):
        """save_uploads only catches PdfError, so a bare FileNotFoundError from an image
        without poppler installed escapes as a 500 instead of a 400 the user can act on."""
        monkeypatch.setenv('PATH', str(tmp_path))
        with pytest.raises(pdf.PdfError, match='poppler'):
            pdf.probe(tmp_path / 'whatever.pdf')

    def test_page_texts_reports_it_too(self, tmp_path, monkeypatch, sample):
        monkeypatch.setenv('PATH', str(tmp_path))
        with pytest.raises(pdf.PdfError, match='poppler'):
            pdf.page_texts(sample)


class TestPageTexts:
    def test_one_entry_per_page_keyed_by_page_number(self, sample):
        texts = pdf.page_texts(sample)
        assert sorted(texts) == [1, 2]
        assert texts[1].splitlines()[0] == 'Pfarre Wien'
        assert 'Dechant Mayer' in texts[1]
        assert 'Dechant Mayer' not in texts[2]
        assert texts[2].splitlines()[0] == 'Pfarre Graz'

    def test_no_trailing_phantom_page(self, sample):
        """pdftotext ends its output with a form feed; splitting on it naively
        invents an extra empty page, which would shift nothing but count wrong."""
        assert len(pdf.page_texts(sample)) == 2

    def test_a_pdf_without_a_text_layer_yields_only_blanks(self, tmp_path):
        blank = tmp_path / 'blank.pdf'
        blank.write_bytes(text_pdf([[], []]))
        assert all(not text.strip() for text in pdf.page_texts(blank).values())

    def test_side_by_side_columns_stay_separate_lines(self, tmp_path):
        """The alignment phase matches one ground-truth line to one segmented line, so
        columns must not be joined. pdftotext -layout would emit 'Pfarre Wien   Pfarre
        Graz' as a single line, which no physical line on the scan can match."""
        path = tmp_path / 'columns.pdf'
        path.write_bytes(columns_pdf(['Pfarre Wien', 'Kaplan Huber'],
                                     ['Pfarre Graz', 'Kaplan Gruber']))
        lines = [l.strip() for l in pdf.page_texts(path)[1].splitlines() if l.strip()]
        assert lines == ['Pfarre Wien', 'Pfarre Graz', 'Kaplan Huber', 'Kaplan Gruber']


def columns_pdf(left: list[str], right: list[str]) -> bytes:
    """Two text columns at the same baselines, which is what a printed schematismus is."""
    import re
    stream = 'BT /F1 12 Tf\n'
    for i, (l, r) in enumerate(zip(left, right)):
        y = 720 - i * 20
        stream += f'1 0 0 1 72 {y} Tm ({l}) Tj\n1 0 0 1 340 {y} Tm ({r}) Tj\n'
    stream += 'ET'
    return re.sub(rb'BT /F1 12 Tf 72 720 Td 14 TL\n\(placeholder\) Tj T\*\nET',
                  stream.encode(), text_pdf([['placeholder']]))
