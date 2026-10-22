from io import BytesIO, StringIO
import os
from pathlib import Path

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


def test_standalone_iptc_is_filtered_from_default_and_explicit_lists(monkeypatch):
    Image.init()
    assert "IPTC" in Image.ID
    payload = b"benign dispatch-only non-image bytes"
    entered = []

    def reject_other_factories(*args, **kwargs):
        raise SyntaxError("intercepted before any non-IPTC decoder")

    def reject_iptc_factory(*args, **kwargs):
        entered.append("IPTC factory")
        raise AssertionError("standalone IPTC factory must not run")

    def observe_iptc_accept(prefix):
        entered.append("IPTC accept")
        return True

    with monkeypatch.context() as scoped:
        for fmt, (_factory, accept) in list(Image.OPEN.items()):
            if fmt == "IPTC":
                scoped.setitem(
                    Image.OPEN, fmt, (reject_iptc_factory, observe_iptc_accept)
                )
            else:
                scoped.setitem(Image.OPEN, fmt, (reject_other_factories, accept))

        with pytest.raises(UnidentifiedImageError):
            open_image(BytesIO(payload))
        with pytest.raises(UnidentifiedImageError):
            open_image(BytesIO(payload), formats=["IPTC"])
        assert entered == []

    with open_image(BytesIO(_encoded_image("PNG"))) as image:
        assert image.format == "PNG"
        assert image.size == (16, 16)


def test_msp_is_filtered_from_default_and_explicit_format_lists(monkeypatch):
    Image.init()
    if "MSP" not in Image.SAVE:
        pytest.skip("Pillow cannot encode MSP in this runtime")
    payload_buffer = BytesIO()
    Image.new("1", (4, 4), 0).save(payload_buffer, format="MSP")
    payload = payload_buffer.getvalue()
    entered = []
    _factory, accept = Image.OPEN["MSP"]

    def reject_factory(*args, **kwargs):
        entered.append("factory")
        raise AssertionError("MSP decoder factory must not run")

    def observe_accept(prefix):
        entered.append("accept")
        return accept(prefix)

    monkeypatch.setitem(Image.OPEN, "MSP", (reject_factory, observe_accept))
    with pytest.raises(UnidentifiedImageError):
        open_image(BytesIO(payload))
    with pytest.raises(UnidentifiedImageError):
        open_image(BytesIO(payload), formats=["MSP"])
    assert entered == []

    with open_image(BytesIO(_encoded_image("PNG"))) as image:
        assert image.format == "PNG"
        assert image.size == (16, 16)


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


@pytest.mark.parametrize("prefix", ["-", "@"])
@pytest.mark.parametrize("path_kind", ["str", "bytes", "path"])
def test_relative_eps_path_is_made_absolute_before_ghostscript(
    tmp_path, monkeypatch, prefix, path_kind
):
    from PIL import EpsImagePlugin

    name = f"{prefix}source.eps"
    (tmp_path / name).write_text(
        "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nshowpage\n",
        encoding="ascii",
    )
    monkeypatch.chdir(tmp_path)
    captured = []

    class StopBeforeGhostscript(Exception):
        pass

    def intercept(command, **_kwargs):
        captured.append(command)
        raise StopBeforeGhostscript

    monkeypatch.setattr(EpsImagePlugin, "has_ghostscript", lambda: True)
    monkeypatch.setattr(EpsImagePlugin, "gs_binary", "gs")
    monkeypatch.setattr(EpsImagePlugin.subprocess, "check_call", intercept)
    if path_kind == "bytes":
        path = os.fsencode(name)
    elif path_kind == "path":
        path = Path(name)
    else:
        path = name

    image = open_image(path)
    try:
        with pytest.raises(StopBeforeGhostscript):
            image.load()
    finally:
        image.close()

    argv = captured[0]
    expected = (
        os.path.join(os.getcwdb(), os.fsencode(name))
        if path_kind == "bytes"
        else os.path.join(os.getcwd(), name)
    )
    assert argv[argv.index("-f") + 1] == expected


def test_absolute_eps_path_is_preserved_before_ghostscript(tmp_path, monkeypatch):
    from PIL import EpsImagePlugin

    path = tmp_path / "@absolute.eps"
    path.write_text(
        "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nshowpage\n",
        encoding="ascii",
    )
    captured = []

    class StopBeforeGhostscript(Exception):
        pass

    def intercept(command, **_kwargs):
        captured.append(command)
        raise StopBeforeGhostscript

    monkeypatch.setattr(EpsImagePlugin, "has_ghostscript", lambda: True)
    monkeypatch.setattr(EpsImagePlugin, "gs_binary", "gs")
    monkeypatch.setattr(EpsImagePlugin.subprocess, "check_call", intercept)
    image = open_image(path)
    try:
        with pytest.raises(StopBeforeGhostscript):
            image.load()
    finally:
        image.close()
    argv = captured[0]
    assert argv[argv.index("-f") + 1] == str(path)


def test_path_prefix_preserves_symlink_dotdot_resolution(tmp_path, monkeypatch):
    real_child = tmp_path / "real" / "child"
    real_child.mkdir(parents=True)
    try:
        (tmp_path / "link").symlink_to(real_child, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        if os.name == "nt":
            pytest.skip(f"symlinks are unavailable: {exc}")
        raise
    Image.new("RGB", (2, 2), "red").save(tmp_path / "real" / "target.png")
    Image.new("RGB", (3, 3), "blue").save(tmp_path / "target.png")
    monkeypatch.chdir(tmp_path)

    with Image.open("link/../target.png") as native:
        assert native.size == (2, 2)
    with open_image("link/../target.png") as guarded:
        assert guarded.size == (2, 2)


@pytest.mark.parametrize("path", ["", b""])
def test_empty_path_keeps_pillow_native_error(path):
    with pytest.raises(FileNotFoundError) as native:
        Image.open(path)
    with pytest.raises(type(native.value)) as guarded:
        open_image(path)
    assert str(guarded.value) == str(native.value)


def _xbm_payload():
    header = (
        b"#define" + b" " * 10 + b"_width 1\r"
        + b"#define" + b" " * 10 + b"_height 1\r"
        + b"#define" + b" " * 10 + b"_x_hot 1\r"
        + b"#define" + b" " * 10 + b"_y_hot 1" + b"\r" * 10
        + b"_bits"
    )
    return header + b"A" * (512 - len(header))
