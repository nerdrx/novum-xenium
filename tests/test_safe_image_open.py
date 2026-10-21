from io import BytesIO, StringIO

import pytest

PIL = pytest.importorskip("PIL")
from PIL import Image, UnidentifiedImageError

from src.safe_image_open import open_image


def _encoded_image(fmt):
    Image.init()
    if fmt not in Image.SAVE:
        pytest.skip(f"Pillow cannot encode {fmt} in this runtime")
    buffer = BytesIO()
    Image.new("RGB", (16, 16), "#3b82f6").save(buffer, format=fmt)
    return buffer.getvalue()


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP", "GIF", "BMP", "TIFF", "ICO"])
def test_default_open_keeps_registered_non_xbm_formats(fmt):
    image = open_image(BytesIO(_encoded_image(fmt)))
    try:
        assert image.format == fmt
        assert image.size == (16, 16)
    finally:
        image.close()


def test_caller_format_allowlist_is_preserved():
    png = _encoded_image("PNG")
    jpeg = _encoded_image("JPEG")
    with open_image(BytesIO(png), formats=["PNG"]) as image:
        assert image.format == "PNG"
    with pytest.raises(UnidentifiedImageError):
        open_image(BytesIO(jpeg), formats=["PNG"])


def test_xbm_is_filtered_from_default_and_explicit_format_lists(monkeypatch):
    Image.init()
    payload = (
        b"#define" + b" " * 10 + b"_width 1\r"
        + b"#define" + b" " * 10 + b"_height 1\r"
        + b"#define" + b" " * 10 + b"_x_hot 1\r"
        + b"#define" + b" " * 10 + b"_y_hot 1" + b"\r" * 10
        + b"_bits"
    )
    payload += b"A" * (512 - len(payload))
    entered = []
    _factory, _accept = Image.OPEN["XBM"]

    def reject_factory(*args, **kwargs):
        entered.append("factory")
        raise AssertionError("XBM decoder factory must not run")

    def observe_accept(prefix):
        entered.append("accept")
        return _accept(prefix)

    monkeypatch.setitem(Image.OPEN, "XBM", (reject_factory, observe_accept))
    with pytest.raises(UnidentifiedImageError):
        open_image(BytesIO(payload))
    with pytest.raises(UnidentifiedImageError):
        open_image(BytesIO(payload), formats=["XBM"])
    assert entered == []


def test_external_binary_stream_lifetime_matches_native_open():
    native_stream = BytesIO(_encoded_image("PNG"))
    helper_stream = BytesIO(_encoded_image("PNG"))
    native_image = Image.open(native_stream)
    helper_image = open_image(helper_stream)
    native_image.close()
    helper_image.close()
    assert helper_stream.closed == native_stream.closed


def test_native_formats_argument_error_is_preserved():
    with pytest.raises(TypeError, match="formats must be a list or tuple"):
        open_image(BytesIO(_encoded_image("PNG")), formats="PNG")


def test_native_mode_and_text_stream_errors_are_preserved():
    with pytest.raises(ValueError, match="bad mode"):
        open_image(BytesIO(), mode="w")
    with pytest.raises(ValueError, match="StringIO cannot be used"):
        open_image(StringIO("not binary"))


def test_non_string_format_entries_cannot_alias_xbm(monkeypatch):
    Image.init()
    entered = []
    _factory, _accept = Image.OPEN["XBM"]

    class XbmAlias:
        def upper(self):
            return "XBM"

    def observe_accept(prefix):
        entered.append("accept")
        return _accept(prefix)

    monkeypatch.setitem(Image.OPEN, "XBM", (_factory, observe_accept))
    with pytest.raises(TypeError, match="formats entries must be strings"):
        open_image(BytesIO(b"not an image"), formats=[XbmAlias()])
    assert entered == []


def test_str_subclass_cannot_override_xbm_filter(monkeypatch):
    Image.init()
    entered = []
    factory, accept = Image.OPEN["XBM"]

    class XbmAlias(str):
        def upper(self):
            raise AssertionError("format filtering must use builtin str normalization")

    def observe_factory(*args, **kwargs):
        entered.append("factory")
        return factory(*args, **kwargs)

    def observe_accept(prefix):
        entered.append("accept")
        return accept(prefix)

    monkeypatch.setitem(Image.OPEN, "XBM", (observe_factory, observe_accept))
    with pytest.raises(UnidentifiedImageError):
        open_image(BytesIO(_xbm_payload()), formats=[XbmAlias("XBM")])
    assert entered == []


def _xbm_payload():
    header = (
        b"#define" + b" " * 10 + b"_width 1\r"
        + b"#define" + b" " * 10 + b"_height 1\r"
        + b"#define" + b" " * 10 + b"_x_hot 1\r"
        + b"#define" + b" " * 10 + b"_y_hot 1" + b"\r" * 10
        + b"_bits"
    )
    return header + b"A" * (512 - len(header))
