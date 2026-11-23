import json

MAX_FIELDS = 100
MAX_KEY = 80
MAX_VALUE = 2000


class Refused(ValueError):
    """Metadata that cannot be kept as given, in words for the person who wrote it."""


def of(stored: str | None) -> list[dict]:
    return json.loads(stored or '[]')


def cleaned(entries: list[dict]) -> list[dict]:
    """The fields as kept: trimmed, empty rows dropped, every value named and no name twice."""
    kept, seen = [], set()
    for entry in entries:
        key, value = entry['key'].strip(), entry['value'].strip()
        if not key and not value:
            continue
        if not key:
            raise Refused('every value needs a field name')
        if key.lower() in seen:
            raise Refused(f'the field "{key}" is there twice')
        if len(key) > MAX_KEY or len(value) > MAX_VALUE:
            raise Refused(f'a field name is at most {MAX_KEY} characters, a value at most {MAX_VALUE}')
        seen.add(key.lower())
        kept.append({'key': key, 'value': value})
    if len(kept) > MAX_FIELDS:
        raise Refused(f'at most {MAX_FIELDS} fields')
    return kept


def merged(pairs: list[tuple[str, str]]) -> list[dict]:
    """Fields from elsewhere, where one name can come twice: its values joined in one field,
    and all of it cut to the size an edit is held to."""
    fields: dict[str, dict] = {}
    for key, value in pairs:
        key = key[:MAX_KEY]
        if not key:
            continue
        held = fields.get(key.lower())
        if held is None:
            fields[key.lower()] = {'key': key, 'value': value}
        elif value:
            held['value'] = f'{held["value"]}; {value}' if held['value'] else value
    return [{'key': f['key'], 'value': f['value'][:MAX_VALUE]} for f in list(fields.values())[:MAX_FIELDS]]
