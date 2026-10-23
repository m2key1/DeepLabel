def text_pdf(pages: list[list[str]]) -> bytes:
    """A minimal PDF with a real text layer: one page per entry, one Tj per line."""
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog = add(b'')          # 1, patched below once Pages is known
    pages_obj = add(b'')        # 2
    font = add(b'/Type /Font /Subtype /Type1 /BaseFont /Helvetica')

    kids = []
    for lines in pages:
        stream = b'BT /F1 12 Tf 72 720 Td 14 TL\n'
        for line in lines:
            escaped = line.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')
            stream += b'(' + escaped.encode('latin-1') + b') Tj T*\n'
        stream += b'ET'
        content = add(b'<< /Length %d >>\nstream\n%s\nendstream' % (len(stream), stream))
        page = add(b'/Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] '
                   b'/Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >>'
                   % (pages_obj, content, font))
        kids.append(page)

    objects[catalog - 1] = b'/Type /Catalog /Pages %d 0 R' % pages_obj
    objects[pages_obj - 1] = (b'/Type /Pages /Kids [%s] /Count %d'
                              % (b' '.join(b'%d 0 R' % k for k in kids), len(kids)))

    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        wrapped = body if body.startswith(b'<<') else b'<< ' + body + b' >>'
        out += b'%d 0 obj\n%s\nendobj\n' % (number, wrapped)
    xref_at = len(out)
    out += b'xref\n0 %d\n' % (len(objects) + 1)
    out += b'0000000000 65535 f \n'
    for offset in offsets:
        out += b'%010d 00000 n \n' % offset
    out += (b'trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n'
            % (len(objects) + 1, catalog, xref_at))
    return bytes(out)
