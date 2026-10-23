"""Getting page images out of a PDF, and the decision behind it: extract the embedded
scan, or render the page.

Extracting keeps the original pixels; rendering resamples them at a fixed DPI. So a page
that is one full-bleed scan is extracted, and anything else - two images, a vector overlay,
a strip-scanned page - is rendered, because extracting one of its pieces would silently
put a fragment of the page into the dataset.
"""
import shutil
import subprocess

import pytest
from PIL import Image

from app import config, pdf

POPPLER = shutil.which('pdftoppm') and shutil.which('pdfimages')
needs_poppler = pytest.mark.skipif(not POPPLER, reason='poppler-utils not installed')


def row(width=2000, height=3000, x_ppi=300, y_ppi=300, kind='image', enc='jpeg'):
    return {'type': kind, 'width': width, 'height': height,
            'x_ppi': x_ppi, 'y_ppi': y_ppi, 'enc': enc}


def size(spec):
    return spec.width, spec.height


# A 2000x3000 image at 300ppi is 480x720pt - exactly the page below, so it covers it.
FULL_PAGE = (480.0, 720.0, 0)


class TestExtractOrRender:
    def test_one_scan_filling_the_page_is_extracted_as_it_is(self):
        spec = pdf._classify(1, FULL_PAGE, [row()])

        assert spec.mode == 'extract'
        assert spec.ext == '.jpg', 'a jpeg stream comes out as a jpeg'

    def test_a_png_stream_keeps_its_own_format(self):
        assert pdf._classify(1, FULL_PAGE, [row(enc='flate')]).ext == '.png'

    def test_a_page_of_two_images_is_rendered(self):
        """Strip-scanned or composite: extracting one piece would put a fragment of the
        page into the dataset."""
        spec = pdf._classify(1, FULL_PAGE, [row(), row()])

        assert spec.mode == 'render'
        assert spec.ext == '.png'

    def test_a_page_with_no_images_at_all_is_rendered(self):
        assert pdf._classify(1, FULL_PAGE, []).mode == 'render'

    def test_something_that_is_not_an_image_is_rendered(self):
        assert pdf._classify(1, FULL_PAGE, [row(kind='smask')]).mode == 'render'

    def test_a_stream_with_no_resolution_is_rendered(self):
        """Without a ppi there is no placed size, so there is no way to tell whether it
        covers the page."""
        assert pdf._classify(1, FULL_PAGE, [row(x_ppi=0)]).mode == 'render'
        assert pdf._classify(1, FULL_PAGE, [row(y_ppi=0)]).mode == 'render'

    def test_a_thumbnail_on_an_otherwise_empty_page_is_rendered(self):
        assert pdf._classify(1, FULL_PAGE, [row(width=200, height=300)]).mode == 'render'

    def test_a_wide_short_image_cannot_pass_on_one_side_alone(self):
        """Both sides are checked independently, so a full-width banner over a tall page
        is not mistaken for the page itself."""
        banner = row(width=2000, height=300)

        assert pdf._classify(1, FULL_PAGE, [banner]).mode == 'render'

    def test_the_page_rotation_is_carried_either_way(self):
        assert pdf._classify(1, (480.0, 720.0, 90), [row()]).rotate == 90
        assert pdf._classify(1, (480.0, 720.0, 270), []).rotate == 270

    def test_the_image_size_is_the_scans_own_or_the_rendered_page_upright(self, monkeypatch):
        """What the pixel limit is checked against before any page is written out."""
        monkeypatch.setattr(config, 'PDF_RENDER_DPI', 400)
        assert size(pdf._classify(1, FULL_PAGE, [row()])) == (2000, 3000)
        assert size(pdf._classify(1, (480.0, 720.0, 90), [row()])) == (3000, 2000)
        assert size(pdf._classify(1, FULL_PAGE, [])) == (2667, 4000)
        assert size(pdf._classify(1, (480.0, 720.0, 270), [])) == (4000, 2667)

    def test_the_coverage_threshold_is_the_configured_one(self, monkeypatch):
        small = row(width=1000, height=1500)  # half the page on each side

        monkeypatch.setattr(config, 'PDF_EXTRACT_COVERAGE', 0.4)
        assert pdf._classify(1, FULL_PAGE, [small]).mode == 'extract'

        monkeypatch.setattr(config, 'PDF_EXTRACT_COVERAGE', 0.9)
        assert pdf._classify(1, FULL_PAGE, [small]).mode == 'render'


class TestWhenPopplerCannotHelp:
    def test_a_missing_binary_is_named_rather_than_crashing_the_upload(self, monkeypatch):
        """Callers only catch PdfError; without this an image without poppler-utils
        answers PDF uploads with a 500 instead of a sentence naming the cause."""
        def absent(*args, **kwargs):
            raise FileNotFoundError

        monkeypatch.setattr(subprocess, 'run', absent)

        with pytest.raises(pdf.PdfError, match='poppler-utils'):
            pdf._run(['pdfinfo', 'book.pdf'])

    def test_the_real_diagnostic_is_preferred_over_the_warnings_before_it(self, monkeypatch):
        """Poppler's warnings say "continuing anyway", which reads absurdly on a
        rejection."""
        def failed(*args, **kwargs):
            return subprocess.CompletedProcess(
                args, 1, '', 'Warning: continuing anyway\nError: PDF file is damaged\n')

        monkeypatch.setattr(subprocess, 'run', failed)

        with pytest.raises(pdf.PdfError, match='PDF file is damaged'):
            pdf._run(['pdfinfo', 'book.pdf'])

    def test_a_failure_with_nothing_to_say_still_raises(self, monkeypatch):
        monkeypatch.setattr(subprocess, 'run',
                            lambda *a, **k: subprocess.CompletedProcess(a, 1, '', ''))

        with pytest.raises(pdf.PdfError, match='poppler failed'):
            pdf._run(['pdfinfo', 'book.pdf'])


class TestTheTextLayer:
    def test_pages_are_split_on_the_form_feed_and_numbered_from_one(self, monkeypatch):
        monkeypatch.setattr(pdf, '_run', lambda argv: 'First page\fSecond page\f')

        assert pdf.page_texts('book.pdf') == {1: 'First page', 2: 'Second page'}

    def test_a_page_without_a_text_layer_comes_back_empty_rather_than_missing(self, monkeypatch):
        monkeypatch.setattr(pdf, '_run', lambda argv: 'First page\f\fThird page\f')

        assert pdf.page_texts('book.pdf')[2] == ''

    def test_a_document_with_no_text_layer_at_all_is_not_an_error(self, monkeypatch):
        monkeypatch.setattr(pdf, '_run', lambda argv: '\f')

        assert pdf.page_texts('book.pdf') == {1: ''}


class TestAskingForOnePage:
    def test_a_page_outside_the_document_is_refused_by_number(self, monkeypatch):
        monkeypatch.setattr(pdf, 'probe', lambda path: [pdf.PageSpec(1, 'render', 0, '.png')])

        with pytest.raises(pdf.PdfError, match='page 7 not in document'):
            pdf.spec_for('book.pdf', 7)

    def test_the_spec_for_a_page_that_is_there_comes_back(self, monkeypatch):
        specs = [pdf.PageSpec(1, 'render', 0, '.png'), pdf.PageSpec(2, 'extract', 90, '.jpg')]
        monkeypatch.setattr(pdf, 'probe', lambda path: specs)

        assert pdf.spec_for('book.pdf', 2) == specs[1]


@needs_poppler
class TestAgainstARealDocument:
    @pytest.fixture
    def book(self, tmp_path):
        """Two pages of a plain rendered PDF, written by Pillow."""
        first = Image.new('RGB', (400, 600), 'white')
        second = Image.new('RGB', (400, 600), 'gray')
        path = tmp_path / 'book.pdf'
        first.save(path, save_all=True, append_images=[second])
        return path

    def test_the_pages_are_counted(self, book):
        assert pdf.page_count(book) == 2

    def test_every_page_gets_a_spec(self, book):
        specs = pdf.probe(book)

        assert [s.page for s in specs] == [1, 2]

    def test_a_page_is_written_out_as_an_image(self, book, tmp_path):
        spec = pdf.spec_for(book, 1)

        out = pdf.materialize(book, spec, tmp_path / 'pages', 'page_0001')

        assert out.exists()
        with Image.open(out) as im:
            assert im.width > 0 and im.height > 0

    def test_the_working_directory_is_cleaned_up_either_way(self, book, tmp_path):
        pdf.materialize(book, pdf.spec_for(book, 1), tmp_path / 'pages', 'page_0001')

        assert [p.name for p in (tmp_path / 'pages').iterdir() if p.name.startswith('.')] == []

    def test_writing_the_same_page_twice_replaces_it(self, book, tmp_path):
        spec = pdf.spec_for(book, 1)
        first = pdf.materialize(book, spec, tmp_path / 'pages', 'page_0001')

        again = pdf.materialize(book, spec, tmp_path / 'pages', 'page_0001')

        assert again == first
        assert len([p for p in (tmp_path / 'pages').iterdir() if p.is_file()]) == 1

    def test_a_page_that_is_not_there_is_refused(self, book, tmp_path):
        with pytest.raises(pdf.PdfError):
            pdf.materialize(book, pdf.PageSpec(9, 'render', 0, '.png'),
                            tmp_path / 'pages', 'page_0009')

    def test_a_file_that_is_not_a_pdf_is_refused_with_popplers_reason(self, tmp_path):
        not_a_pdf = tmp_path / 'notes.pdf'
        not_a_pdf.write_text('just some text')

        with pytest.raises(pdf.PdfError):
            pdf.page_count(not_a_pdf)
