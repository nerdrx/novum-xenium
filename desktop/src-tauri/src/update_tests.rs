//! Transaction-level tests for the desktop updater. These use a disposable Git
//! remote and a fake Docker CLI; they never contact the host Docker daemon.

#![cfg(unix)]

use super::*;
use std::{
    env,
    os::unix::fs::PermissionsExt,
    process::{Command, Output},
    sync::{mpsc, Mutex, OnceLock},
};

static PROCESS_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn git(git: &Path, cwd: Option<&Path>, args: &[&str]) -> String {
    let mut command = Command::new(git);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command.output().expect("run fixture git command");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn executable(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

struct EnvRestore(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (key, old) in self.0.drain(..) {
            if let Some(value) = old {
                env::set_var(key, value);
            } else {
                env::remove_var(key);
            }
        }
    }
}

fn set_test_env(values: &[(&'static str, std::ffi::OsString)]) -> EnvRestore {
    let restore = values
        .iter()
        .map(|(key, _)| (*key, env::var_os(key)))
        .collect();
    for (key, value) in values {
        env::set_var(key, value);
    }
    EnvRestore(restore)
}

fn git_output(git: &Path, cwd: &Path, args: &[&str]) -> Output {
    Command::new(git)
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap()
}

fn fixture_update(fail_updated_health: bool) {
    let _env_lock = PROCESS_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = tempfile::tempdir().unwrap();
    let bare = root.path().join("origin.git");
    let seed = root.path().join("seed");
    let checkout = root.path().join("checkout");
    let data = root.path().join("project-data");
    let config_dir = root.path().join("desktop-config");
    let bin = root.path().join("bin");
    let trace = root.path().join("commands.log");
    let up_count = root.path().join("up-count");
    let health_mode = root.path().join("health-mode");
    fs::create_dir_all(&seed).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&config_dir).unwrap();
    fs::create_dir_all(&bin).unwrap();
    fs::write(data.join("customer.txt"), "before update").unwrap();
    fs::write(&health_mode, "healthy").unwrap();

    let real_git = env::split_paths(&env::var_os("PATH").unwrap())
        .map(|dir| dir.join("git"))
        .find(|path| path.is_file())
        .expect("git executable in PATH");
    let git_wrapper = bin.join("git");
    executable(
        &git_wrapper,
        &format!(
            "#!/bin/sh\nprintf 'git %s\\n' \"$*\" >> \"$NX_UPDATE_TRACE\"\nexec \"$NX_REAL_GIT\" \"$@\"\n"
        ),
    );

    git(
        &real_git,
        None,
        &[
            "init",
            "--bare",
            "--initial-branch=main",
            bare.to_str().unwrap(),
        ],
    );
    git(
        &real_git,
        None,
        &["init", "--initial-branch=main", seed.to_str().unwrap()],
    );
    git(
        &real_git,
        Some(&seed),
        &["config", "user.name", "Fixture User"],
    );
    git(
        &real_git,
        Some(&seed),
        &["config", "user.email", "fixture@example.test"],
    );
    fs::write(seed.join("docker-compose.yml"), "services: {}\n").unwrap();
    fs::write(seed.join("VERSION.txt"), "one\n").unwrap();
    git(
        &real_git,
        Some(&seed),
        &["add", "docker-compose.yml", "VERSION.txt"],
    );
    git(&real_git, Some(&seed), &["commit", "-m", "initial version"]);
    let original = git(&real_git, Some(&seed), &["rev-parse", "HEAD"]);
    git(
        &real_git,
        Some(&seed),
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    git(&real_git, Some(&seed), &["push", "-u", "origin", "main"]);
    git(
        &real_git,
        None,
        &[
            "--git-dir",
            bare.to_str().unwrap(),
            "symbolic-ref",
            "HEAD",
            "refs/heads/main",
        ],
    );
    git(
        &real_git,
        None,
        &["clone", bare.to_str().unwrap(), checkout.to_str().unwrap()],
    );
    let old_branch = git(
        &real_git,
        Some(&checkout),
        &["symbolic-ref", "--short", "HEAD"],
    );
    fs::write(seed.join("VERSION.txt"), "two\n").unwrap();
    git(&real_git, Some(&seed), &["add", "VERSION.txt"]);
    git(&real_git, Some(&seed), &["commit", "-m", "updated version"]);
    git(&real_git, Some(&seed), &["push", "origin", "main"]);
    let target = git(&real_git, Some(&seed), &["rev-parse", "HEAD"]);

    let fake_docker = bin.join("docker");
    executable(
        &fake_docker,
        r##"#!/usr/bin/env python3
import json, os, pathlib, re, shutil, sys, tarfile
args = sys.argv[1:]
trace = pathlib.Path(os.environ["NX_UPDATE_TRACE"])
with trace.open("a") as f:
    f.write("docker " + " ".join(args) + "\n")
def compose_args():
    return args[1:]
if args and args[0] == "compose":
    sub = compose_args()
    if "config" in sub:
        print(json.dumps({"services":{"odysseus":{"volumes":[{"type":"bind","source":os.environ["NX_UPDATE_DATA"],"target":"/app/data"}]}},"volumes":{}}))
    elif "images" in sub:
        print("sha256:old-image")
    elif "port" in sub:
        print("127.0.0.1:" + os.environ["APP_PORT"])
    elif "up" in sub:
        counter = pathlib.Path(os.environ["NX_UPDATE_UP_COUNT"])
        count = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(count))
        if count == 1:
            if os.environ["NX_UPDATE_FAIL_HEALTH"] == "1":
                pathlib.Path(os.environ["NX_UPDATE_HEALTH_MODE"]).write_text("unhealthy")
                pathlib.Path(os.environ["NX_UPDATE_DATA"], "customer.txt").write_text("changed by updated service")
            else:
                pathlib.Path(os.environ["NX_UPDATE_HEALTH_MODE"]).write_text("healthy")
        else:
            pathlib.Path(os.environ["NX_UPDATE_HEALTH_MODE"]).write_text("healthy")
    elif "stop" in sub or "build" in sub:
        pass
    else:
        print("unexpected compose command", sub, file=sys.stderr); sys.exit(3)
elif args[:2] == ["image", "tag"]:
    pass
elif args and args[0] == "run":
    mounts = {}
    for i, arg in enumerate(args):
        if arg == "--mount":
            fields = dict(part.split("=", 1) for part in args[i + 1].split(",") if "=" in part)
            mounts[fields.get("dst")] = pathlib.Path(fields["src"])
    src, backup = mounts["/source"], mounts["/backup"]
    script = args[-1]
    match = re.search(r"/backup/([A-Za-z0-9_.-]+)", script)
    if not match:
        print("archive path missing", file=sys.stderr); sys.exit(4)
    archive = backup / match.group(1)
    if script.startswith("tar -czf"):
        with tarfile.open(archive, "w:gz") as tar:
            for child in src.iterdir(): tar.add(child, arcname=child.name)
    elif "tar -xzf" in script:
        for child in src.iterdir():
            shutil.rmtree(child) if child.is_dir() else child.unlink()
        with tarfile.open(archive, "r:gz") as tar: tar.extractall(src)
    else:
        print("unexpected helper command", script, file=sys.stderr); sys.exit(5)
else:
    print("unexpected docker command", args, file=sys.stderr); sys.exit(6)
"##,
    );

    // Health probes exercise the same real TCP code as production. The fake
    // Compose command flips the endpoint unhealthy only after the new stack
    // comes up, then healthy after rollback startup.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let mode = health_mode.clone();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let server = std::thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        loop {
            if matches!(
                stop_rx.try_recv(),
                Ok(()) | Err(mpsc::TryRecvError::Disconnected)
            ) {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                    let mut request = String::new();
                    let mut reader = std::io::BufReader::new(&mut stream);
                    loop {
                        request.clear();
                        match reader.read_line(&mut request) {
                            Ok(0) | Err(_) => break,
                            Ok(_) if request == "\r\n" => break,
                            Ok(_) => {}
                        }
                    }
                    drop(reader);
                    let healthy = fs::read_to_string(&mode)
                        .map(|s| s.trim() == "healthy")
                        .unwrap_or(false);
                    let response = if healthy {
                        "HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n"
                    } else {
                        "HTTP/1.0 503 Unavailable\r\nContent-Length: 0\r\n\r\n"
                    };
                    let _ = stream.write_all(response.as_bytes());
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(_) => break,
            }
        }
    });

    let original_path = env::var_os("PATH").unwrap();
    let mut paths = vec![bin.clone()];
    paths.extend(env::split_paths(&original_path));
    let path_value = env::join_paths(paths).unwrap();
    let _restore_env = set_test_env(&[
        ("PATH", path_value),
        ("NX_REAL_GIT", real_git.clone().into_os_string()),
        ("NX_UPDATE_TRACE", trace.clone().into_os_string()),
        ("NX_UPDATE_DATA", data.clone().into_os_string()),
        ("NX_UPDATE_UP_COUNT", up_count.clone().into_os_string()),
        (
            "NX_UPDATE_HEALTH_MODE",
            health_mode.clone().into_os_string(),
        ),
        (
            "NX_UPDATE_FAIL_HEALTH",
            if fail_updated_health {
                "1".into()
            } else {
                "0".into()
            },
        ),
    ]);
    let config = DesktopConfig {
        checkout: checkout.to_string_lossy().into_owned(),
        port,
        project: "nx-fixture".into(),
    };
    let backup_root = fs::canonicalize(&config_dir).unwrap();
    let result =
        update_inner_with_health_timeout(&config, &backup_root, Duration::from_millis(500))
            .unwrap_or_else(|error| {
                let trace = fs::read_to_string(&trace).unwrap_or_default();
                panic!("updater returned an error: {error}\ncommands:\n{trace}");
            });

    let final_head = git(&real_git, Some(&checkout), &["rev-parse", "HEAD"]);
    let final_branch = git(
        &real_git,
        Some(&checkout),
        &["symbolic-ref", "--short", "HEAD"],
    );
    let data_after = fs::read_to_string(data.join("customer.txt")).unwrap();
    let log = fs::read_to_string(&trace).unwrap();
    let lines = log.lines().collect::<Vec<_>>();
    let stop_position = lines
        .iter()
        .position(|line| line.starts_with("docker compose") && line.contains(" stop "))
        .unwrap();
    let switch_position = lines
        .iter()
        .position(|line| line.starts_with("git switch "))
        .unwrap();
    assert!(
        stop_position < switch_position,
        "backend must stop before source switches: {log}"
    );
    assert!(
        log.contains("docker image tag sha256:old-image novum-xenium-rollback:nx-fixture-"),
        "old image was not pinned for rollback: {log}"
    );

    if fail_updated_health {
        assert!(
            !result.updated && result.rolled_back,
            "failed new health check must report successful rollback: {result:?}"
        );
        assert_eq!(final_head, original);
        assert_eq!(final_branch, old_branch);
        assert_eq!(data_after, "before update");
        assert!(
            log.contains("docker image tag sha256:old-image nx-fixture-odysseus"),
            "rollback must retag the previous image: {log}"
        );
        assert_eq!(
            log.lines()
                .filter(|line| line.starts_with("docker run "))
                .count(),
            2,
            "snapshot and restore must both run: {log}"
        );
    } else {
        assert!(
            result.updated && !result.rolled_back,
            "healthy update must report success: {result:?}\ncommands:\n{log}"
        );
        assert_eq!(final_head, target);
        assert_eq!(final_branch, old_branch);
        assert_eq!(data_after, "before update");
        assert_eq!(
            log.lines()
                .filter(|line| line.starts_with("docker run "))
                .count(),
            1,
            "successful update should snapshot without restoring: {log}"
        );
    }

    let _ = stop_tx.send(());
    server.join().unwrap();
}

#[test]
fn update_transaction_restores_data_image_and_original_branch_after_health_failure() {
    fixture_update(true);
}

#[test]
fn update_transaction_keeps_snapshot_and_fast_forwards_original_branch_when_healthy() {
    fixture_update(false);
}
