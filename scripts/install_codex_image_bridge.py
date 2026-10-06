#!/usr/bin/env python3
"""Install the optional user service; run only from a trusted checkout."""
from pathlib import Path
import secrets
import shlex
import shutil

ROOT = Path(__file__).resolve().parent.parent
USER_HOME = Path.home()


def install():
    token = ROOT / "data/credentials/codex-image-bridge.token"
    token.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not token.exists():
        token.write_text(secrets.token_urlsafe(48) + "\n")
    token.chmod(0o600)

    bin_dir = USER_HOME / ".local/bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    launcher = bin_dir / "odysseus-codex-images"
    codex = shutil.which("codex")
    # User services have a smaller PATH than a desktop terminal. Remember the
    # installed CLI without baking its host-specific path into the repository.
    cli_default = ('if [ -z "${CODEX_CLI:-}" ]; then\n  export CODEX_CLI=' +
                   shlex.quote(codex) + '\nfi\n') if codex else ''
    launcher.write_text("#!/bin/sh\n" + cli_default + "exec /usr/bin/env python3 " +
                        shlex.quote(str(ROOT / "scripts/codex_image_bridge.py")) + "\n")
    launcher.chmod(0o700)

    unit_dir = USER_HOME / ".config/systemd/user"
    unit_dir.mkdir(parents=True, exist_ok=True)
    source = ROOT / "config/odysseus-codex-images.service"
    (unit_dir / source.name).write_text(source.read_text())
    print("Installed the optional bridge service. To start it, run:")
    print("  systemctl --user daemon-reload && systemctl --user enable --now odysseus-codex-images")
    if not codex:
        print("Codex was not found. Set CODEX_CLI=/absolute/path/to/codex in ~/.config/odysseus/codex-images.env")


if __name__ == "__main__":
    install()
