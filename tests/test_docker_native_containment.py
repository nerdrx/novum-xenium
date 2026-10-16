"""Keep nested command namespaces available without an unconfined container."""
import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_native_profile_keeps_closed_default_and_sensitive_syscall_denials():
    profile = json.loads((ROOT / 'docker/seccomp-bubblewrap.json').read_text())
    assert profile['defaultAction'] == 'SCMP_ACT_ERRNO'
    unconditional = {
        name for rule in profile['syscalls']
        if rule['action'] == 'SCMP_ACT_ALLOW'
        and not rule.get('includes') and not rule.get('excludes') and not rule.get('args')
        for name in rule['names']
    }
    assert {'clone', 'unshare', 'mount', 'umount2', 'pivot_root'} <= unconditional
    assert not {'bpf', 'ptrace', 'open_by_handle_at', 'keyctl', 'kexec_load', 'init_module'} & unconditional
    assert any('clone3' in rule['names'] and rule['action'] == 'SCMP_ACT_ERRNO'
               and rule.get('errnoRet') == 38 for rule in profile['syscalls'])


def test_all_install_variants_use_profile_without_adding_host_admin_capabilities():
    for filename in ('docker-compose.yml', 'docker-compose.gpu-amd.yml', 'docker-compose.gpu-nvidia.yml'):
        app = yaml.safe_load((ROOT / filename).read_text())['services']['odysseus']
        opts = app['security_opt']
        assert 'seccomp=./docker/seccomp-bubblewrap.json' in opts
        assert 'no-new-privileges:true' in opts
        assert 'systempaths=unconfined' in opts
        assert 'seccomp=unconfined' not in opts
        assert not app.get('privileged')
        assert 'SYS_ADMIN' not in app.get('cap_add', [])
    assert '    bubblewrap \\' in (ROOT / 'Dockerfile').read_text()
