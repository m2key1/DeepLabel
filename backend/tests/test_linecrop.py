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


class TestPaintingOutWhatIsNotTheLine:
    """A minimum-area rectangle is not the line. Where the polygon is not a rectangle - and
    on every tilt the crop refuses to deskew, where it falls back to the axis-aligned box -
    the corners hold whatever else was there, and the model is handed the row above as if it
    were part of this line."""

    # 45 degrees sits in the band linecrop will not deskew (SLIGHT_MAX..VERT_MIN), so the
    # crop is the axis-aligned box around the polygon and its corners are wide open.
    LINE = [(120, 280), (280, 120), (300, 140), (140, 300)]
    NEIGHBOUR = (130, 130, 190, 170)

    def crop(self, mask: bool):
        img = Image.new('RGB', (400, 400), (255, 255, 255))
        img.paste((0, 0, 0), self.NEIGHBOUR)
        return linecrop.crop_line(img, [list(p) for p in self.LINE], mask=mask)

    def darkness(self, crop) -> int:
        return sum(1 for px in crop.convert('L').getdata() if px < 128)

    def test_the_unmasked_crop_carries_the_neighbours_ink(self):
        # The premise: without masking the neighbour really is inside the crop.
        assert self.darkness(self.crop(mask=False)) > 1000

    def test_masking_leaves_only_what_the_polygon_claims(self):
        assert self.darkness(self.crop(mask=True)) == 0

    def test_it_does_not_move_or_resize_the_crop(self):
        # Only the pixels outside the polygon change; every model's geometry is untouched.
        assert self.crop(mask=True).size == self.crop(mask=False).size

    def test_the_paint_is_the_paper_around_the_line_not_a_flat_block(self):
        img = Image.new('RGB', (400, 400), (238, 232, 214))
        img.paste((0, 0, 0), self.NEIGHBOUR)
        crop = linecrop.crop_line(img, [list(p) for p in self.LINE], mask=True)
        assert crop.getpixel((2, 2)) == (238, 232, 214)

    def rect_at(self, degrees: float):
        """A rectangle the detectors would produce, leaning by `degrees`."""
        rad = math.radians(degrees)
        ux, uy = math.cos(rad), math.sin(rad)
        nx, ny = -uy, ux
        return [[200 + a * 150 * ux + b * 25 * nx, 200 + a * 150 * uy + b * 25 * ny]
                for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]

    def test_a_rectangle_comes_out_byte_for_byte_as_it_did(self):
        """The overwhelming majority of lines: the polygon already is the rectangle the crop
        warps from, so there is nothing outside it and masking must change nothing at all -
        not merely look similar. Turning it on is then free for them."""
        for degrees in (0, 12, 75):
            img = Image.new('RGB', (400, 400), (255, 255, 255))
            img.paste((0, 0, 0), self.NEIGHBOUR)
            poly = self.rect_at(degrees)
            plain = linecrop.crop_line(img, poly, mask=False)
            masked = linecrop.crop_line(img, poly, mask=True)
            assert list(masked.getdata()) == list(plain.getdata()), f'{degrees} degrees'
