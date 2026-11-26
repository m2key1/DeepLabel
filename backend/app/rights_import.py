import re
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree

from app import imports, ingest, rights

# The namespaces rights facts hide in beside the scans: Dublin Core and its terms (also
# inside a METS dmdSec), METSRights under a rightsMD, and xlink on a MODS accessCondition.
_DC_NAMESPACES = ('http://purl.org/dc/elements/1.1/', 'http://purl.org/dc/terms/')
_DC_RIGHTS = tuple(f'{{{ns}}}{name}' for ns in _DC_NAMESPACES for name in ('rights', 'license'))
_DC_HOLDER = tuple(f'{{{ns}}}rightsHolder' for ns in _DC_NAMESPACES)
_METS_RIGHTS = 'http://cosimo.stanford.edu/sdr/metsrights/'
_RESOURCE = '{http://www.w3.org/1999/02/22-rdf-syntax-ns#}resource'
_HREF = ('{http://www.w3.org/1999/xlink}href', 'href')


def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1]


def _clean(value: str) -> str:
    """One line without the wrapping an export wrote around a value, cut to what a field holds."""
    return re.sub(r'\s+', ' ', value).strip()[:rights.MAX_TEXT]


def _text(element) -> str:
    return _clean(''.join(element.itertext()))


def _attr(element, *names: str) -> str:
    return next((element.get(name) for name in names if element.get(name)), '')


def _under(element, parents: dict, name: str) -> bool:
    node = parents.get(element)
    while node is not None:
        if _local(node.tag) == name:
            return True
        node = parents.get(node)
    return False


def _take(fields: dict, field: str, value: str) -> None:
    """First recognised value wins per field: an import never takes back what a source said."""
    if value and field not in fields:
        fields[field] = value


def _offered(fields: dict, *values: str) -> None:
    """status when a value names one of the offered statements - a page or legal-code address
    counts - and otherwise what the source called it, kept in the note."""
    for value in values:
        statement = rights.canonical(value) if value else None
        if statement:
            _take(fields, 'status', statement)
            return
    for value in values:
        if value:
            _take(fields, 'note', f'Rights as the source gives them: {value}')
            return


def _licence(fields: dict, element, parents: dict) -> None:
    """In sourceDesc a licence is about the scans; in the publicationStmt it belongs to the
    transcriptions, and only counts as such when it names a statement we offer - free text
    there is about the TEI file's own text, not the scans."""
    values = (element.get('target') or '', _text(element))
    if _under(element, parents, 'sourceDesc'):
        _offered(fields, *values)
    elif _under(element, parents, 'publicationStmt'):
        for value in values:
            statement = rights.canonical(value) if value else None
            if statement:
                _take(fields, 'transcription_licence', statement)
                return


def _first_wins(fields: dict, found: dict) -> None:
    """A later file only fills the fields the earlier ones left empty."""
    fields.update({field: value for field, value in found.items() if field not in fields})


def from_metadata(content: bytes) -> dict:
    """What one XML document says about rights, as fields: the scans' rights from a TEI
    sourceDesc, METS rightsMD or any Dublin Core it carries, and the transcriptions'
    licence from the TEI publicationStmt. Only non-empty fields; unparseable says nothing."""
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError:
        return {}
    parents = {child: parent for parent in root.iter() for child in parent}
    fields = {}
    for element in root.iter():
        tag, local = element.tag, _local(element.tag)
        if local == 'licence':
            _licence(fields, element, parents)
        elif local == 'p' and _under(element, parents, 'sourceDesc') and _under(element, parents, 'availability'):
            _take(fields, 'credit', _text(element))
        elif tag in _DC_RIGHTS:
            _offered(fields, _attr(element, _RESOURCE, 'resource') or _text(element))
        elif tag in _DC_HOLDER:
            _take(fields, 'holder', _text(element))
        elif tag == f'{{{_METS_RIGHTS}}}RightsDeclaration' and _under(element, parents, 'rightsMD'):
            _offered(fields, _text(element))
        elif tag == f'{{{_METS_RIGHTS}}}RightsHolderName' and _under(element, parents, 'rightsMD'):
            _take(fields, 'holder', _text(element))
        elif local == 'accessCondition':
            _offered(fields, _attr(element, *_HREF), _text(element))
    return fields


def _read(archive, name: str) -> bytes:
    """A member too big to read whole counts as unreadable, like the rest: it says nothing."""
    try:
        return imports.read_within_limit(archive, name)
    except (OSError, KeyError, zipfile.BadZipFile, imports.ImportError_):
        return b''


def _head(archive, name: str) -> bytes:
    """Enough of a member to name a TEI file, without reading a whole volume of scans."""
    try:
        with archive.open(name) as member:
            return member.read(4000)
    except (OSError, KeyError, zipfile.BadZipFile):
        return b''


def _mets_member(name: str) -> bool:
    filename = PurePosixPath(name).name
    return filename.lower().endswith('mets.xml') or filename.startswith('METS')


def _metadata_member(name: str) -> bool:
    filename = PurePosixPath(name).name.lower()
    return filename.endswith('.dc.xml') or (filename.startswith('metadata') and filename.endswith('.xml'))


def from_zip(fileobj) -> dict:
    """What an import zip's own files say about rights, as fields: METS first, then
    metadata and DC files, then any TEI it holds, told by its first bytes - so a METS
    status stands even when a page's TEI names another. An unreadable zip says nothing.
    Leaves the file at its start; the caller reads the zip again."""
    try:
        archive = zipfile.ZipFile(fileobj)
    except (zipfile.BadZipFile, OSError):
        fileobj.seek(0)
        return {}
    fields = {}
    read = set()
    try:
        members = [name for name in archive.namelist()
                   if not name.endswith('/') and not ingest.is_system_entry(name)]
        for kind in (_mets_member, _metadata_member):
            for name in sorted(members):
                if kind(name) and name not in read:
                    read.add(name)
                    _first_wins(fields, from_metadata(_read(archive, name)))
        for name in sorted(members):
            if name not in read and PurePosixPath(name).suffix.lower() == '.xml' and b'<TEI' in _head(archive, name):
                read.add(name)
                _first_wins(fields, from_metadata(_read(archive, name)))
    finally:
        fileobj.seek(0)
    return fields
