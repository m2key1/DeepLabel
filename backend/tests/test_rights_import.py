import io
import zipfile

from app import rights_import


def _zip_with(files: dict[str, str | bytes]) -> io.BytesIO:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    buffer.seek(0)
    return buffer


TEI_EXPORT = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc>
<publicationStmt><distributor>DeepLabel</distributor>
<availability><licence target="http://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0</licence>
</availability></publicationStmt>
<sourceDesc><bibl><title>Letters</title>
<availability>
<licence target="https://creativecommons.org/licenses/by/4.0/legalcode">CC BY 4.0</licence>
<p>Scans courtesy of
  the Wien Museum</p>
</availability>
</bibl></sourceDesc>
</fileDesc></teiHeader><text><body><p>Page text</p></body></text></TEI>"""


def test_deeplabel_tei_export():
    fields = rights_import.from_metadata(TEI_EXPORT.encode())
    assert fields == {'status': 'http://creativecommons.org/licenses/by/4.0/',
                      'credit': 'Scans courtesy of the Wien Museum',
                      'transcription_licence': 'http://creativecommons.org/publicdomain/zero/1.0/'}


def test_tei_licence_text_names_the_statement_without_a_target():
    content = b"""<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc>
<sourceDesc><bibl><availability><licence>
http://creativecommons.org/licenses/by-sa/4.0/
</licence></availability></bibl></sourceDesc>
</fileDesc></teiHeader></TEI>"""
    assert rights_import.from_metadata(content) == {
        'status': 'http://creativecommons.org/licenses/by-sa/4.0/'}


def test_tei_licence_of_an_unknown_statement_goes_to_note():
    content = b"""<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc>
<sourceDesc><bibl><availability>
<licence target="http://example.org/licences/house-licence">House rules</licence>
</availability></bibl></sourceDesc>
</fileDesc></teiHeader></TEI>"""
    assert rights_import.from_metadata(content) == {
        'note': 'Rights as the source gives them: http://example.org/licences/house-licence'}


METS_METSRIGHTS = """<mets:mets xmlns:mets="http://www.loc.gov/METS/"
    xmlns:mr="http://cosimo.stanford.edu/sdr/metsrights/">
<mets:dmdSec><mets:rightsMD>
<mr:RightsDeclaration RIGHTSDECID="In Copyright">http://rightsstatements.org/vocab/InC/1.0/</mr:RightsDeclaration>
<mr:RightsHolder><mr:RightsHolderName>Wien Museum</mr:RightsHolderName></mr:RightsHolder>
</mets:rightsMD></mets:dmdSec>
</mets:mets>"""


def test_mets_metsrights_declaration_and_holder():
    fields = rights_import.from_metadata(METS_METSRIGHTS.encode())
    assert fields == {'status': 'http://rightsstatements.org/vocab/InC/1.0/',
                      'holder': 'Wien Museum'}


METS_DUBLIN_CORE = """<mets xmlns="http://www.loc.gov/METS/"
    xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
    xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<dmdSec><mdWrap><xmlData>
<dc:rights rdf:resource="http://creativecommons.org/licenses/by/4.0/"/>
<dcterms:rightsHolder>Wien Museum</dcterms:rightsHolder>
</xmlData></mdWrap></dmdSec>
</mets>"""


def test_mets_dmdsec_dublin_core_rights_and_holder():
    fields = rights_import.from_metadata(METS_DUBLIN_CORE.encode())
    assert fields == {'status': 'http://creativecommons.org/licenses/by/4.0/',
                      'holder': 'Wien Museum'}


def test_dublin_core_rights_text_of_an_unknown_statement_goes_to_note():
    content = (b'<mets xmlns:dcterms="http://purl.org/dc/terms/" '
               b'xmlns:dc="http://purl.org/dc/elements/1.1/">'
               b'<dmdSec><dc:license>Educational use only</dc:license></dmdSec></mets>')
    assert rights_import.from_metadata(content) == {
        'note': 'Rights as the source gives them: Educational use only'}


def test_long_rights_text_is_cut_to_max_text():
    content = (b'<record xmlns:dc="http://purl.org/dc/elements/1.1/">'
               b'<dc:rights>' + b'x' * (rights_import.rights.MAX_TEXT + 1000) + b'</dc:rights></record>')
    assert rights_import.from_metadata(content) == {
        'note': 'Rights as the source gives them: ' + 'x' * rights_import.rights.MAX_TEXT}


MODS_ING_EDU = """<mods xmlns="http://www.loc.gov/mods/v3" xmlns:xlink="http://www.w3.org/1999/xlink">
<accessCondition type="use and reproduction"
xlink:href="https://rightsstatements.org/page/InC-EDU/1.0/?language=en">
In Copyright - Educational Use Permitted
</accessCondition>
</mods>"""


def test_mods_access_condition_via_xlink_href():
    fields = rights_import.from_metadata(MODS_ING_EDU.encode())
    assert fields == {'status': 'http://rightsstatements.org/vocab/InC-EDU/1.0/'}


def test_mods_access_condition_text_of_an_unknown_statement_goes_to_note():
    content = (b'<mods xmlns="http://www.loc.gov/mods/v3"><accessCondition>'
               b'Educational use inside the reading room</accessCondition></mods>')
    assert rights_import.from_metadata(content) == {
        'note': 'Rights as the source gives them: Educational use inside the reading room'}


METS_IN_COPYRIGHT = METS_METSRIGHTS

TEI_WITH_CREDIT = """<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc>
<publicationStmt><availability>
<licence target="http://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0</licence>
</availability></publicationStmt>
<sourceDesc><bibl><availability>
<licence target="http://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0</licence>
<p>Scans courtesy of the Wien Museum</p>
</availability></bibl></sourceDesc>
</fileDesc></teiHeader></TEI>"""


def test_zip_mets_statement_stands_and_tei_fills_the_fields_it_lacks():
    buffer = _zip_with({'scans/page_0001.xml': TEI_WITH_CREDIT,
                        'mets.xml': METS_IN_COPYRIGHT,
                        '__MACOSX/mets.xml': METS_DUBLIN_CORE,
                        'scans/page_0001.tif': b'this image is only here to be skipped'})
    fields = rights_import.from_zip(buffer)
    assert fields == {'status': 'http://rightsstatements.org/vocab/InC/1.0/',
                      'holder': 'Wien Museum',
                      'credit': 'Scans courtesy of the Wien Museum',
                      'transcription_licence': 'http://creativecommons.org/publicdomain/zero/1.0/'}


def test_tei_only_zip():
    buffer = _zip_with({'page_0001.xml': TEI_EXPORT, 'page_0002.xml': TEI_EXPORT,
                        'images/page_0001.jpg': b'image'})
    fields = rights_import.from_zip(buffer)
    assert fields == {'status': 'http://creativecommons.org/licenses/by/4.0/',
                      'credit': 'Scans courtesy of the Wien Museum',
                      'transcription_licence': 'http://creativecommons.org/publicdomain/zero/1.0/'}
    assert buffer.tell() == 0


def test_zip_without_any_rights_says_nothing():
    buffer = _zip_with({'page_0001.xml': '<Page xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2013-07-15"/>',
                        'images/page_0001.jpg': b'image'})
    assert rights_import.from_zip(buffer) == {}


def test_unreadable_zip_says_nothing_and_leaves_the_file_at_its_start():
    buffer = io.BytesIO(b'this is not a zip archive')
    assert rights_import.from_zip(buffer) == {}
    assert buffer.tell() == 0


def test_unparseable_xml_says_nothing():
    assert rights_import.from_metadata(b'<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader>') == {}
