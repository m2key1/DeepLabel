"""What every model actually reads: the crop a line polygon turns into.

A minimum-area rectangle is 180-degree symmetric, so the polygon alone never says which
way is up. Whatever rule resolves that has to hold for a line standing on its side as
firmly as for one lying flat - a crop that comes out upside down is read upside down by
the OCR model and trained on upside down.
"""
import math

from PIL import Image

from app import linecrop

WHITE, BLACK = 255, 0


def page(marks: list[tuple[int, int, int, int]]) -> Image.Image:
    """A white page with black blocks, so the crop's own contents say which end is which."""
    img = Image.new('L', (400, 400), WHITE)
    for box in marks:
        img.paste(BLACK, box)
    return img


def ink(img: Image.Image, box: tuple[int, int, int, int]) -> float:
    """Mean darkness of a region, 0 for white and 1 for black."""
    region = img.crop(box)
    return 1 - sum(region.getdata()) / (255 * region.width * region.height)


def reads_left_to_right(crop: Image.Image) -> bool:
    """Whether the mark that was painted at the start of the line came out on the left."""
    third = max(1, crop.width // 3)
    return ink(crop, (0, 0, third, crop.height)) > ink(crop, (crop.width - third, 0, crop.width, crop.height))


class TestALineLyingFlat:
    def test_it_reads_left_to_right(self):
        # The line runs along x; its first word is the block at the left end.
        img = page([(50, 100, 70, 140)])
        crop = linecrop.crop_line(img, [[50, 100], [250, 100], [250, 140], [50, 140]])

        assert crop.width > crop.height
        assert reads_left_to_right(crop)

    def test_a_line_printed_right_to_left_on_the_page_is_not_turned_around(self):
        """The polygon is wound the other way; the mark is still at the same end of it."""
        img = page([(50, 100, 70, 140)])
        crop = linecrop.crop_line(img, [[250, 140], [50, 140], [50, 100], [250, 100]])

        assert reads_left_to_right(crop)


class TestALineStandingOnItsSide:
    """A line printed down the page - a spine, a marginal note, a colour chart's label -
    is laid flat by the crop. Which of the two ways round it lands is what a rectangle
    cannot say, and the answer has to be the same every time."""

    # The strip runs down the page from y=50; its first word is the block at the top.
    STRIP = [[100, 50], [140, 50], [140, 250], [100, 250]]
    MARK = [(100, 50, 140, 70)]

    def test_it_is_laid_flat_reading_left_to_right(self):
        crop = linecrop.crop_line(page(self.MARK), self.STRIP)

        assert crop.width > crop.height
        assert reads_left_to_right(crop)

    def test_a_hair_of_tilt_either_way_does_not_turn_it_upside_down(self):
        """A detected polygon is never exactly vertical. A twentieth of a pixel of lean
        must not decide which way up a page's every marginal note is read."""
        for lean in (0.05, -0.05, 0.4, -0.4):
            poly = [[100 + lean, 50], [140 + lean, 50], [140 - lean, 250], [100 - lean, 250]]

            crop = linecrop.crop_line(page(self.MARK), poly)

            assert reads_left_to_right(crop), f'lean of {lean}px turned the crop around'


class TestThePersistedOrientation:
    def test_a_half_turn_puts_the_start_of_the_line_on_the_right(self):
        img = page([(50, 100, 70, 140)])
        poly = [[50, 100], [250, 100], [250, 140], [50, 140]]

        crop = linecrop.crop_line(img, poly, orientation=180)

        assert not reads_left_to_right(crop)

    def test_a_quarter_turn_stands_the_crop_up(self):
        img = page([(50, 100, 70, 140)])
        poly = [[50, 100], [250, 100], [250, 140], [50, 140]]

        crop = linecrop.crop_line(img, poly, orientation=90)

        assert crop.height > crop.width
