import hashlib
import io
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from app import config

# Pillow refuses a picture larger than this rather than decoding it. A decompression bomb
# is a few kilobytes on the wire that becomes gigabytes in memory, so the byte ceiling on
# the upload does not protect anything by itself. 40 megapixels is past any camera someone
# would take a portrait with. Deliberately not None, which is what the pipeline sets: that
# is a choice for a trusted scan on a machine with a GPU, not for a public upload.
Image.MAX_IMAGE_PIXELS = 40_000_000


class Refused(Exception):
    """Why this picture cannot be kept, in words meant for whoever uploaded it."""


def path_for(user_id: int) -> Path:
    return config.AVATAR_DIR / f'{user_id}.png'


def token_for(data: bytes) -> str:
    """Names the version, not the file. It goes in the URL, so a new picture is a new
    address and no cache anywhere has to be told the old one is stale."""
    return hashlib.sha256(data).hexdigest()[:16]


def store(user_id: int, raw: bytes) -> str:
    """Keep this picture as this person's, and answer with its version token.

    Whatever arrives is decoded, squared off centre and re-encoded at a fixed size, so
    what is served is never the bytes that were uploaded - which also settles the format,
    the dimensions and anything the original was carrying besides an image.
    """
    if not raw:
        raise Refused('the file is empty')
    if len(raw) > config.AVATAR_MAX_BYTES:
        raise Refused(f'the file is larger than {config.AVATAR_MAX_BYTES // (1024 * 1024)} MB')
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img.load()
            square = _square(img.convert('RGBA'))
    except Image.DecompressionBombError:
        raise Refused('the image has too many pixels to be a picture of a person') from None
    except (UnidentifiedImageError, OSError, ValueError):
        raise Refused('that file is not an image the server can read') from None

    out = io.BytesIO()
    square.save(out, format='PNG', optimize=True)
    data = out.getvalue()
    config.AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    # Written beside and moved into place: a half-written file that another request was
    # already serving would show as a broken picture rather than the old one.
    final = path_for(user_id)
    staging = final.with_suffix('.png.partial')
    staging.write_bytes(data)
    staging.replace(final)
    return token_for(data)


def _square(img: Image.Image) -> Image.Image:
    """The middle of the picture, at the size everything is kept at. Cropped rather than
    squashed: a portrait squashed into a square is worse than one with its edges trimmed."""
    side = min(img.size)
    left = (img.width - side) // 2
    top = (img.height - side) // 2
    cropped = img.crop((left, top, left + side, top + side))
    return cropped.resize((config.AVATAR_SIZE, config.AVATAR_SIZE), Image.LANCZOS)


def remove(user_id: int) -> None:
    path_for(user_id).unlink(missing_ok=True)


def url_for(username: str, token: str) -> str | None:
    """Where the browser asks for it. None when this person has none, so a caller can put
    the initials there instead without a round trip that would answer 404."""
    if not token:
        return None
    return f'/api/users/{username}/avatar?v={token}'
