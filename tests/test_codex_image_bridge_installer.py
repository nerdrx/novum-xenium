"""The optional installer stays inside its chosen checkout and user home."""
import importlib.util
from pathlib import Path
import stat


def test_installer_preserves_token_and_quotes_checkout(tmp_path, capsys, monkeypatch):
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location(
        "codex_bridge_installer", root / "scripts/install_codex_image_bridge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    checkout = tmp_path / "checkout with spaces"
    home = tmp_path / "user"
    (checkout / "config").mkdir(parents=True)
    (checkout / "config/odysseus-codex-images.service").write_text(
        (root / "config/odysseus-codex-images.service").read_text())
    module.ROOT, module.USER_HOME = checkout, home
    monkeypatch.setattr(module.shutil, 'which', lambda _name: '/opt/Codex with spaces/codex')

    module.install()
    token = checkout / "data/credentials/codex-image-bridge.token"
    original = token.read_text()
    assert len(original.strip()) >= 48
    assert stat.S_IMODE(token.stat().st_mode) == 0o600
    launcher = home / ".local/bin/odysseus-codex-images"
    assert "'" + str(checkout / "scripts/codex_image_bridge.py") + "'" in launcher.read_text()
    assert "export CODEX_CLI='/opt/Codex with spaces/codex'" in launcher.read_text()
    assert stat.S_IMODE(launcher.stat().st_mode) == 0o700
    assert (home / ".config/systemd/user/odysseus-codex-images.service").exists()
    module.install()
    assert token.read_text() == original
    assert original.strip() not in capsys.readouterr().out
