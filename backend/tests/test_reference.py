from app.reference import Document, Span, cut, monotonic, normalize, overlap_ratio

LETTER = Document('letter-01.txt',
                  'Mein lieber Freund, ich danke Dir fuer Deinen Brief\n'
                  'Das Wetter hier in Wien ist seit Tagen truebe\n'
                  'Ich habe gestern lange an dem Bildnis gearbeitet\n'
                  'Die Farben wollen noch nicht zusammenstimmen\n'
                  'Morgen fahre ich zu meiner Mutter nach Hietzing\n'
                  'Schreibe mir bald wieder, ich warte sehr darauf')
NOTE = Document('letter-02.txt',
                'Lieber Elias, nur ein paar Zeilen in grosser Eile\n'
                'Der Zug geht schon um sieben Uhr frueh\n'
                'Ich nehme das blaue Kleid und den Mantel mit\n'
                'Bis Sonntag, dann erzaehle ich Dir alles')

# The same lines as recognition leaves them: a few letters wrong, nothing rewritten.
SCANNED = [
    ['Mein lieber Freund, ich danke Dir fuer Deinen Bricf',
     'Das Wetter hier in Wien ist seit Tagen truebc'],
    ['Ich habe gestern lange an dem Bildnis gearbeitct',
     'Die Farben wollen noch nicht zusammenstimmcn'],
    ['Morgen fahre ich zu meiner Mutter nach Hietzmg',
     'Schreibe mir bald wieder, ich warte sehr darauf'],
    ['Lieber Elias, nur ein paar Zeilen in grosser Eile',
     'Der Zug geht schon um sieben Uhr frueh'],
    ['Ich nehme das blaue Kleid und den Mantel mit',
     'Bis Sonntag, dann erzaehle ich Dir alles'],
]


def test_each_page_receives_exactly_the_lines_it_carries():
    spans = cut([LETTER, NOTE], SCANNED, overlap=0)
    assert [span.document for span in spans] == [
        'letter-01.txt', 'letter-01.txt', 'letter-01.txt', 'letter-02.txt', 'letter-02.txt']
    assert [span.lines for span in spans] == [
        ['Mein lieber Freund, ich danke Dir fuer Deinen Brief',
         'Das Wetter hier in Wien ist seit Tagen truebe'],
        ['Ich habe gestern lange an dem Bildnis gearbeitet',
         'Die Farben wollen noch nicht zusammenstimmen'],
        ['Morgen fahre ich zu meiner Mutter nach Hietzing',
         'Schreibe mir bald wieder, ich warte sehr darauf'],
        ['Lieber Elias, nur ein paar Zeilen in grosser Eile',
         'Der Zug geht schon um sieben Uhr frueh'],
        ['Ich nehme das blaue Kleid und den Mantel mit',
         'Bis Sonntag, dann erzaehle ich Dir alles'],
    ]


def test_span_text_joins_the_held_lines():
    spans = cut([LETTER, NOTE], SCANNED, overlap=0)
    assert spans[1].text == ('Ich habe gestern lange an dem Bildnis gearbeitet\n'
                             'Die Farben wollen noch nicht zusammenstimmen')


def test_every_page_anchored_both_of_its_lines():
    spans = cut([LETTER, NOTE], SCANNED, overlap=0)
    assert [span.anchors for span in spans] == [2, 2, 2, 2, 2]
    assert all(span.score >= 0.9 for span in spans)


def test_overlap_widens_a_span_without_crossing_into_another_document():
    """Page 2 ends its letter, so two lines of slack may only reach backwards - the next
    document begins on the next leaf and can never be part of this page's reference."""
    spans = cut([LETTER, NOTE], SCANNED, overlap=2)
    assert spans[2].lines == [
        'Ich habe gestern lange an dem Bildnis gearbeitet',
        'Die Farben wollen noch nicht zusammenstimmen',
        'Morgen fahre ich zu meiner Mutter nach Hietzing',
        'Schreibe mir bald wieder, ich warte sehr darauf',
    ]
    assert spans[3].lines == [
        'Lieber Elias, nur ein paar Zeilen in grosser Eile',
        'Der Zug geht schon um sieben Uhr frueh',
        'Ich nehme das blaue Kleid und den Mantel mit',
        'Bis Sonntag, dann erzaehle ich Dir alles',
    ]


def test_overlap_is_clamped_at_the_start_of_a_document():
    spans = cut([LETTER, NOTE], SCANNED, overlap=2)
    assert spans[0].lines[0] == 'Mein lieber Freund, ich danke Dir fuer Deinen Brief'
    assert spans[0].first_line == 0


def test_a_page_that_anchored_nothing_takes_the_share_its_neighbours_leave():
    unreadable = [SCANNED[0], ['zzzz qqqq', 'xxxx wwww'], SCANNED[2], SCANNED[3], SCANNED[4]]
    spans = cut([LETTER, NOTE], unreadable, overlap=0)
    assert spans[1].anchors == 0
    assert spans[1].lines == [
        'Ich habe gestern lange an dem Bildnis gearbeitet',
        'Die Farben wollen noch nicht zusammenstimmen',
    ]
    assert spans[1].document == 'letter-01.txt'
    assert spans[0].lines == [
        'Mein lieber Freund, ich danke Dir fuer Deinen Brief',
        'Das Wetter hier in Wien ist seit Tagen truebe',
    ]


def test_a_document_read_across_one_page_keeps_all_of_its_lines():
    spans = cut([NOTE], [[
        'Lieber Elias, nur ein paar Zeilen in grosser Eile',
        'Der Zug geht schon um sieben Uhr frueh',
        'Ich nehme das blaue Kleid und den Mantel mit',
        'Bis Sonntag, dann erzaehle ich Dir alles',
    ]], overlap=0)
    assert len(spans) == 1
    assert spans[0].lines == NOTE.text.splitlines()


def test_pages_outnumbering_the_corpus_still_divide_it_in_order():
    """Four leaves, a two-line document: every leaf is placed and the order holds."""
    short = Document('note.txt', 'Der Zug geht schon um sieben Uhr frueh\n'
                                 'Bis Sonntag, dann erzaehle ich Dir alles')
    spans = cut([short], [['Der Zug geht schon um sieben Uhr frueh'], [''], [''],
                          ['Bis Sonntag, dann erzaehle ich Dir alles']], overlap=0)
    assert spans[0].lines == ['Der Zug geht schon um sieben Uhr frueh']
    assert spans[3].lines == ['Bis Sonntag, dann erzaehle ich Dir alles']
    assert all(span.document == 'note.txt' for span in spans)


def test_nothing_to_cut_yields_empty_spans():
    assert cut([], SCANNED) == [Span() for _ in SCANNED]
    assert cut([LETTER], []) == []
    assert cut([Document('empty.txt', '   ')], SCANNED) == [Span() for _ in SCANNED]


def test_monotonic_keeps_the_run_that_advances_together():
    anchors = [(0, 0, 0.9), (0, 1, 0.9), (1, 2, 0.9), (2, 3, 0.9)]
    assert monotonic(anchors) == anchors


def test_monotonic_drops_an_anchor_that_jumps_backwards():
    anchors = [(0, 0, 0.9), (1, 7, 0.9), (1, 1, 0.9), (2, 2, 0.9), (3, 3, 0.9)]
    assert monotonic(anchors) == [(0, 0, 0.9), (1, 1, 0.9), (2, 2, 0.9), (3, 3, 0.9)]


def test_monotonic_allows_two_pages_to_share_one_corpus_line():
    """Equal corpus indices do not cross, so a repeated line keeps both anchors."""
    anchors = [(0, 3, 0.9), (1, 3, 0.9), (2, 4, 0.9)]
    assert monotonic(anchors) == anchors


def test_monotonic_on_nothing():
    assert monotonic([]) == []


def test_normalize_keeps_words_and_drops_case_and_punctuation():
    assert normalize('  Lieber Elias, nur ein paar Zeilen! ') == 'lieber elias nur ein paar zeilen'
    assert normalize('---') == ''


def test_overlap_ratio_is_jaccard_over_trigrams():
    assert overlap_ratio({'abc', 'bcd'}, {'abc', 'bcd'}) == 1.0
    assert overlap_ratio({'abc', 'bcd'}, {'abc', 'xyz'}) == 1 / 3
    assert overlap_ratio(set(), {'abc'}) == 0.0


def test_a_repeated_corpus_line_does_not_pull_every_page_onto_one_copy():
    """A corpus repeats itself - a salutation, a dating line, a refrain - and every copy
    scores identically. Picking the first would anchor all three leaves to the same line,
    which collapses the cut: the pages before it hold nothing and the last holds the lot.
    """
    refrain = Document('refrain.txt', '\n'.join(['Immer wieder dasselbe'] * 6))
    spans = cut([refrain], [['Immer wieder dasselbe', 'Immer wieder dasselbe']] * 3, overlap=0)
    assert [len(span.lines) for span in spans] == [2, 2, 2]
    assert [span.anchors for span in spans] == [2, 2, 2]


def test_a_corpus_far_longer_than_the_scans_still_gives_the_page_everything():
    long_text = Document('long.txt', '\n'.join(f'Zeile {i} des Textes' for i in range(50)))
    spans = cut([long_text], [['Zeile 0 des Textes']], overlap=0)
    assert len(spans[0].lines) == 50


def test_a_page_with_more_lines_than_the_corpus_holds_takes_what_there_is():
    single = Document('single.txt', 'Nur eine einzige Zeile')
    spans = cut([single], [['Nur eine einzige Zeile', 'und noch etwas', 'und mehr']], overlap=0)
    assert spans[0].lines == ['Nur eine einzige Zeile']
    assert spans[0].anchors == 1
