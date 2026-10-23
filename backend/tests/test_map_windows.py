"""Where the prediction window lands on a tile, and which window each pixel is taken from.

The model reads a fixed square window; a tile of any size is covered by overlapping
windows and the masks are stitched back. A pixel taken from the wrong window, or from
outside it, shifts every polygon polygonized from the stitched mask.
"""
import pytest

from runner import map_windows


def stitch(width: int, height: int, window: int, predict) -> list[list]:
    """The runner's paste, written out in plain lists: `predict(x, y)` is what a window
    placed at (x, y) says about its own local pixel, and the stitched mask is read back."""
    out = [[None] * width for _ in range(height)]
    for win in map_windows.windows(width, height, window):
        for gy in range(win.keep_top, win.keep_bottom):
            for gx in range(win.keep_left, win.keep_right):
                assert out[gy][gx] is None, f'pixel {(gx, gy)} pasted twice'
                out[gy][gx] = predict(win, gx - win.x, gy - win.y)
    return out


class TestAxis:
    def test_a_side_no_longer_than_the_window_is_one_window_at_zero(self):
        assert map_windows.axis_spans(300, 512) == [(0, 0, 300)]
        assert map_windows.axis_spans(512, 512) == [(0, 0, 512)]

    def test_windows_overlap_by_a_quarter_and_the_last_ends_on_the_edge(self):
        # stride 384: starts 0, 384, then 488 so the last window ends exactly on 1000.
        spans = map_windows.axis_spans(1000, 512)
        assert [start for start, _, _ in spans] == [0, 384, 488]
        assert spans[-1][0] + 512 == 1000

    def test_each_overlap_is_split_at_its_middle(self):
        # Window 0 covers 0-512 and window 1 384-896: they meet at 448. Window 1 and the
        # edge-aligned window 2 (488-1000) meet at (488 + 896) // 2 = 692.
        assert map_windows.axis_spans(1000, 512) == [(0, 0, 448), (384, 448, 692), (488, 692, 1000)]

    def test_an_exact_multiple_of_the_stride_adds_no_redundant_window(self):
        assert map_windows.axis_spans(896, 512) == [(0, 0, 448), (384, 448, 896)]

    @pytest.mark.parametrize('length', [256, 511, 513, 1024, 1500, 4096])
    def test_every_pixel_is_kept_once_and_inside_its_window(self, length):
        spans = map_windows.axis_spans(length, 512)
        assert spans[0][1] == 0 and spans[-1][2] == length
        for (_, _, hi), (_, lo, _) in zip(spans, spans[1:]):
            assert hi == lo
        for start, lo, hi in spans:
            assert start <= lo < hi <= start + 512

    def test_a_kept_pixel_away_from_the_tile_edge_is_never_near_its_window_edge(self):
        # The point of overlapping: the model's border context is cut away, except where
        # the tile itself ends and there is nothing more to see.
        length, window = 4096, 512
        for start, lo, hi in map_windows.axis_spans(length, window):
            if lo > 0:
                assert lo - start >= window // 8
            if hi < length:
                assert start + window - hi >= window // 8


class TestStitch:
    def test_a_model_that_reports_global_coordinates_stitches_back_to_them(self):
        """If every window's mask is the global position of its pixel, the stitched mask
        is exactly the global grid: no pixel shifted by its window's offset."""
        width, height = 37, 23
        out = stitch(width, height, 16, lambda win, lx, ly: (win.x + lx, win.y + ly))
        assert out == [[(x, y) for x in range(width)] for y in range(height)]

    def test_a_pixel_comes_from_the_window_whose_middle_is_nearest(self):
        out = stitch(40, 16, 16, lambda win, lx, ly: win.x)
        # 40 px with a 16 px window: windows at 0, 12, 24. They meet at 14 and 26.
        assert [out[0][x] for x in (0, 13, 14, 25, 26, 39)] == [0, 0, 12, 12, 24, 24]

    def test_a_tile_smaller_than_the_window_is_one_window_cropped_back(self):
        wins = map_windows.windows(300, 200, 512)
        assert [(w.x, w.y, w.keep_left, w.keep_top, w.keep_right, w.keep_bottom) for w in wins] \
            == [(0, 0, 0, 0, 300, 200)]

    def test_a_non_square_tile_is_covered_along_each_axis_on_its_own(self):
        wins = map_windows.windows(1000, 512, 512)
        assert [(w.x, w.y) for w in wins] == [(0, 0), (384, 0), (488, 0)]
