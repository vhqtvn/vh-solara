#!/usr/bin/env python3
"""Detached background shell job manager for repo-local OpenCode work."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_FILE = "job.json"
LOG_FILE = "job.log"
SCHEMA_VERSION = 1
FINAL_STATES = {"succeeded", "failed", "stopped"}
ACTIVE_STATES = {"queued", "starting", "running"}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def repo_root() -> Path:
    override = os.environ.get("VH-SOLARA_BGSHELL_JOB_REPO_ROOT")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[4]


def slugify(value: str) -> str:
    cleaned = []
    for char in value.strip().lower():
        if char.isalnum():
            cleaned.append(char)
        elif char in {"-", "_", ".", " "}:
            cleaned.append("-")
    slug = "".join(cleaned).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    if not slug:
        raise SystemExit("Expected a non-empty slug-like value")
    return slug


def relative_to_repo(path: Path) -> str:
    try:
        return str(path.relative_to(repo_root()))
    except ValueError:
        return str(path)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    temp.replace(path)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def opencode_db_path() -> Path | None:
    override = os.environ.get("VH-SOLARA_BGSHELL_OPENCODE_DB")
    if override:
        candidate = Path(override)
        return candidate if candidate.exists() else None
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    candidate = base / "opencode" / "opencode.db"
    return candidate if candidate.exists() else None


def opencode_session_row(db_path: Path, session_id: str) -> tuple[str | None, str | None]:
    try:
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            row = conn.execute(
                "SELECT slug, parent_id FROM session WHERE id = ?",
                (session_id,),
            ).fetchone()
    except sqlite3.DatabaseError:
        return None, None
    if not row:
        return None, None
    return row[0], row[1]


def resolve_session_name(explicit: str | None) -> str:
    if explicit:
        return slugify(explicit)
    session_id = os.environ.get("OPENCODE_SESSION_ID")
    if not session_id:
        raise SystemExit("No OpenCode session binding found. Pass --session explicitly or run from an OpenCode shell.")
    bindings_dir = repo_root() / ".opencode" / "state" / "session-bindings"

    visited: set[str] = set()
    cursor: str | None = session_id
    while cursor and cursor not in visited:
        visited.add(cursor)
        binding_path = bindings_dir / f"{cursor}.json"
        if not binding_path.exists():
            break
        binding = read_json(binding_path)
        name = binding.get("session_name")
        if name:
            return slugify(name)
        cursor = binding.get("parent_session_id") or None

    db_path = opencode_db_path()
    if db_path is not None:
        visited.clear()
        cursor = session_id
        while cursor and cursor not in visited:
            visited.add(cursor)
            slug, parent_id = opencode_session_row(db_path, cursor)
            if slug:
                return slugify(slug)
            cursor = parent_id

    binding_path = bindings_dir / f"{session_id}.json"
    if not binding_path.exists():
        raise SystemExit(f"Session binding not found: {binding_path}")
    raise SystemExit(
        f"Session binding {binding_path} has no session_name and no ancestor or OpenCode-db slug "
        "could be resolved; pass --session explicitly."
    )


def resolve_job_dir(session_name: str, job_name: str) -> Path:
    return repo_root() / "tmp" / "agent-runs" / session_name / "bg-jobs" / job_name


def state_path(job_dir: Path) -> Path:
    return job_dir / STATE_FILE


def log_path(job_dir: Path) -> Path:
    return job_dir / LOG_FILE


def pid_state(pid: int | None) -> str | None:
    if not pid or pid <= 0:
        return None
    stat_path = Path("/proc") / str(pid) / "stat"
    if not stat_path.exists():
        return None
    try:
        stat_fields = stat_path.read_text().split()
    except OSError:
        return None
    if len(stat_fields) < 3:
        return None
    return stat_fields[2]


def pid_alive(pid: int | None) -> bool:
    state = pid_state(pid)
    return state not in {None, "Z"}


def tail_lines(path: Path, count: int) -> list[str]:
    if count <= 0 or not path.exists():
        return []
    return list(deque(path.read_text().splitlines(), maxlen=count))


def parse_env_overrides(items: list[str]) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise SystemExit(f"Expected KEY=VALUE for --env, got: {item}")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise SystemExit(f"Invalid environment override: {item}")
        overrides[key] = value
    return overrides


def compute_state(job: dict[str, Any]) -> str:
    recorded = job.get("state", "unknown")
    child_alive = pid_alive(job.get("child_pid"))
    wrapper_alive = pid_alive(job.get("wrapper_pid"))
    if job.get("stop_requested_at") and not child_alive and not wrapper_alive:
        return "stopped"
    if recorded in FINAL_STATES and not child_alive:
        return recorded
    if child_alive:
        return "running"
    if wrapper_alive and recorded in {"queued", "starting"}:
        return recorded
    if job.get("finished_at"):
        if job.get("stop_requested_at"):
            return "stopped"
        if job.get("return_code") == 0:
            return "succeeded"
        return "failed"
    if recorded in ACTIVE_STATES and not child_alive and not wrapper_alive:
        return "interrupted"
    return recorded


def refresh_state(job_file: Path, job: dict[str, Any]) -> tuple[dict[str, Any], str]:
    observed = compute_state(job)
    if observed != job.get("state"):
        job["state"] = observed
        if observed == "interrupted" and not job.get("interrupted_at"):
            job["interrupted_at"] = now_iso()
    job["last_status_at"] = now_iso()
    write_json(job_file, job)
    return job, observed


def build_status(job_file: Path, lines: int) -> dict[str, Any]:
    job = read_json(job_file)
    job, observed = refresh_state(job_file, job)
    job_dir = job_file.parent
    log_file = log_path(job_dir)
    child_pid = job.get("child_pid")
    wrapper_pid = job.get("wrapper_pid")
    return {
        "schema_version": job.get("schema_version", SCHEMA_VERSION),
        "session_name": job.get("session_name"),
        "job_name": job.get("job_name"),
        "state": observed,
        "attempt": job.get("attempt"),
        "cwd": job.get("cwd"),
        "command": job.get("command"),
        "env_overrides": job.get("env_overrides", {}),
        "job_dir": relative_to_repo(job_dir),
        "log_path": relative_to_repo(log_file),
        "wrapper_pid": wrapper_pid,
        "wrapper_alive": pid_alive(wrapper_pid),
        "child_pid": child_pid,
        "child_alive": pid_alive(child_pid),
        "return_code": job.get("return_code"),
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "interrupted_at": job.get("interrupted_at"),
        "stop_requested_at": job.get("stop_requested_at"),
        "last_log_lines": list(tail_lines(log_file, lines)),
    }


def spawn_wrapper(job_dir: Path) -> int:
    command = [sys.executable, str(Path(__file__).resolve()), "_run", "--job-dir", str(job_dir)]
    env = os.environ.copy()
    env["VH-SOLARA_BGSHELL_JOB_REPO_ROOT"] = str(repo_root())
    process = subprocess.Popen(
        command,
        cwd=str(repo_root()),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return process.pid


def wait_for_start(job_file: Path, timeout_seconds: float) -> dict[str, Any]:
    deadline = time.time() + max(timeout_seconds, 0.0)
    latest = read_json(job_file)
    while time.time() < deadline:
        latest = read_json(job_file)
        if latest.get("state") in {"starting", "running", "succeeded", "failed", "stopped"} and latest.get("wrapper_pid"):
            return latest
        time.sleep(0.1)
    return latest


def resolve_job_file(*, session: str | None, job: str | None, job_dir: str | None) -> Path:
    if job_dir:
        resolved = Path(job_dir).resolve()
        job_file = state_path(resolved)
        if not job_file.exists():
            raise SystemExit(f"Job state not found: {job_file}")
        return job_file
    if not session or not job:
        raise SystemExit("Provide either --job-dir or both --session and --job")
    return state_path(resolve_job_dir(slugify(session), slugify(job)))


def command_launch(args: argparse.Namespace) -> dict[str, Any]:
    command = args.command[1:] if args.command and args.command[0] == "--" else args.command
    if not command:
        raise SystemExit("Expected a command after '--' for launch")

    session_name = resolve_session_name(args.session)
    job_name = slugify(args.job)
    job_dir = resolve_job_dir(session_name, job_name)
    job_file = state_path(job_dir)
    log_file = log_path(job_dir)

    previous: dict[str, Any] | None = None
    attempt = 1
    if job_file.exists():
        previous = read_json(job_file)
        previous_state = compute_state(previous)
        if previous_state not in FINAL_STATES and previous_state != "interrupted":
            raise SystemExit(f"Job already exists and is active: {relative_to_repo(job_dir)} ({previous_state})")
        attempt = int(previous.get("attempt", 0)) + 1

    env_overrides = parse_env_overrides(args.env)
    cwd = (repo_root() / args.cwd).resolve() if not Path(args.cwd).is_absolute() else Path(args.cwd).resolve()
    payload = {
        "schema_version": SCHEMA_VERSION,
        "session_name": session_name,
        "job_name": job_name,
        "state": "queued",
        "attempt": attempt,
        "cwd": str(cwd),
        "command": command,
        "env_overrides": env_overrides,
        "job_dir": relative_to_repo(job_dir),
        "log_path": relative_to_repo(log_file),
        "created_at": previous.get("created_at", now_iso()) if previous else now_iso(),
        "updated_at": now_iso(),
        "wrapper_pid": None,
        "child_pid": None,
        "child_pgid": None,
        "return_code": None,
        "started_at": None,
        "finished_at": None,
        "interrupted_at": None,
        "stop_requested_at": None,
    }
    write_json(job_file, payload)

    wrapper_pid = spawn_wrapper(job_dir)
    payload = read_json(job_file)
    payload["wrapper_pid"] = wrapper_pid
    payload["updated_at"] = now_iso()
    write_json(job_file, payload)

    _ = wait_for_start(job_file, args.wait_timeout)
    return build_status(job_file, args.lines)


def command_status(args: argparse.Namespace) -> dict[str, Any]:
    job_file = resolve_job_file(session=args.session, job=args.job, job_dir=args.job_dir)
    return build_status(job_file, args.lines)


def command_logs(args: argparse.Namespace) -> dict[str, Any]:
    job_file = resolve_job_file(session=args.session, job=args.job, job_dir=args.job_dir)
    status = build_status(job_file, 0)
    return {
        "session_name": status["session_name"],
        "job_name": status["job_name"],
        "state": status["state"],
        "log_path": status["log_path"],
        "last_log_lines": tail_lines(repo_root() / status["log_path"], args.lines),
    }


def _signal_process_group(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        return


def command_stop(args: argparse.Namespace) -> dict[str, Any]:
    job_file = resolve_job_file(session=args.session, job=args.job, job_dir=args.job_dir)
    job = read_json(job_file)
    job, _ = refresh_state(job_file, job)

    child_pgid = job.get("child_pgid")
    child_pid = job.get("child_pid")
    wrapper_pid = job.get("wrapper_pid")

    if child_pgid:
        _signal_process_group(int(child_pgid), signal.SIGTERM)
    elif child_pid and pid_alive(child_pid):
        os.kill(int(child_pid), signal.SIGTERM)

    if args.force:
        time.sleep(0.2)
        if child_pgid:
            _signal_process_group(int(child_pgid), signal.SIGKILL)
        elif child_pid and pid_alive(child_pid):
            os.kill(int(child_pid), signal.SIGKILL)

    if wrapper_pid and pid_alive(wrapper_pid):
        try:
            os.kill(int(wrapper_pid), signal.SIGTERM)
        except ProcessLookupError:
            pass

    job = read_json(job_file)
    job["stop_requested_at"] = now_iso()
    job["updated_at"] = now_iso()
    write_json(job_file, job)
    return build_status(job_file, args.lines)


def command_list(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root() / "tmp" / "agent-runs"
    rows: list[dict[str, Any]] = []
    if root.exists():
        for session_dir in sorted(root.iterdir()):
            jobs_dir = session_dir / "bg-jobs"
            if not jobs_dir.exists():
                continue
            for job_dir in sorted(jobs_dir.iterdir()):
                job_file = state_path(job_dir)
                if not job_file.exists():
                    continue
                status = build_status(job_file, args.lines)
                rows.append(
                    {
                        "session_name": status["session_name"],
                        "job_name": status["job_name"],
                        "state": status["state"],
                        "attempt": status["attempt"],
                        "job_dir": status["job_dir"],
                        "child_pid": status["child_pid"],
                        "child_alive": status["child_alive"],
                    }
                )
    return {"jobs": rows}


def command_resume(args: argparse.Namespace) -> dict[str, Any]:
    job_file = resolve_job_file(session=args.session, job=args.job, job_dir=args.job_dir)
    job = read_json(job_file)
    observed = compute_state(job)
    if observed not in FINAL_STATES and observed != "interrupted":
        raise SystemExit(f"Cannot resume active job in state: {observed}")

    job["attempt"] = int(job.get("attempt", 0)) + 1
    job["state"] = "queued"
    job["updated_at"] = now_iso()
    job["return_code"] = None
    job["started_at"] = None
    job["finished_at"] = None
    job["interrupted_at"] = None
    job["stop_requested_at"] = None
    job["wrapper_pid"] = None
    job["child_pid"] = None
    job["child_pgid"] = None
    write_json(job_file, job)

    wrapper_pid = spawn_wrapper(job_file.parent)
    job = read_json(job_file)
    job["wrapper_pid"] = wrapper_pid
    job["updated_at"] = now_iso()
    write_json(job_file, job)

    _ = wait_for_start(job_file, args.wait_timeout)
    return build_status(job_file, args.lines)


def command_run(args: argparse.Namespace) -> int:
    job_dir = Path(args.job_dir).resolve()
    job_file = state_path(job_dir)
    job = read_json(job_file)
    log_file = log_path(job_dir)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("a", encoding="utf-8") as log_handle:
        job["state"] = "starting"
        job["started_at"] = now_iso()
        job["updated_at"] = now_iso()
        write_json(job_file, job)

        env = os.environ.copy()
        env.update(job.get("env_overrides", {}))

        process = subprocess.Popen(
            job["command"],
            cwd=job.get("cwd", str(repo_root())),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True,
        )

        job = read_json(job_file)
        job["state"] = "running"
        job["child_pid"] = process.pid
        try:
            job["child_pgid"] = os.getpgid(process.pid)
        except ProcessLookupError:
            job["child_pgid"] = None
        job["updated_at"] = now_iso()
        write_json(job_file, job)

        return_code = process.wait()

    job = read_json(job_file)
    stop_requested = bool(job.get("stop_requested_at"))
    if stop_requested:
        state = "stopped"
    elif return_code == 0:
        state = "succeeded"
    else:
        state = "failed"
    job["state"] = state
    job["return_code"] = return_code
    job["finished_at"] = now_iso()
    job["updated_at"] = now_iso()
    write_json(job_file, job)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage detached background shell jobs")
    subparsers = parser.add_subparsers(dest="command_name", required=True)

    launch = subparsers.add_parser("launch", help="Launch a detached job")
    launch.add_argument("--session", help="Session alias")
    launch.add_argument("--job", required=True, help="Job name")
    launch.add_argument("--cwd", default=".", help="Working directory (repo-relative by default)")
    launch.add_argument("--env", action="append", default=[], help="Environment override KEY=VALUE")
    launch.add_argument("--lines", type=int, default=20, help="Log lines to include")
    launch.add_argument("--wait-timeout", type=float, default=5.0, help="Seconds to wait for startup status")
    launch.add_argument("command", nargs=argparse.REMAINDER)

    status = subparsers.add_parser("status", help="Show job status")
    status.add_argument("--session")
    status.add_argument("--job")
    status.add_argument("--job-dir")
    status.add_argument("--lines", type=int, default=20)

    logs = subparsers.add_parser("logs", help="Tail job logs")
    logs.add_argument("--session")
    logs.add_argument("--job")
    logs.add_argument("--job-dir")
    logs.add_argument("--lines", type=int, default=80)

    stop = subparsers.add_parser("stop", help="Stop a running job")
    stop.add_argument("--session")
    stop.add_argument("--job")
    stop.add_argument("--job-dir")
    stop.add_argument("--force", action="store_true")
    stop.add_argument("--lines", type=int, default=20)

    lst = subparsers.add_parser("list", help="List all jobs")
    lst.add_argument("--lines", type=int, default=0)

    resume = subparsers.add_parser("resume", help="Resume a finished or interrupted job")
    resume.add_argument("--session")
    resume.add_argument("--job")
    resume.add_argument("--job-dir")
    resume.add_argument("--lines", type=int, default=20)
    resume.add_argument("--wait-timeout", type=float, default=5.0)

    run = subparsers.add_parser("_run", help=argparse.SUPPRESS)
    run.add_argument("--job-dir", required=True)

    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command_name == "launch":
        print(json.dumps(command_launch(args), indent=2))
        return 0
    if args.command_name == "status":
        print(json.dumps(command_status(args), indent=2))
        return 0
    if args.command_name == "logs":
        print(json.dumps(command_logs(args), indent=2))
        return 0
    if args.command_name == "stop":
        print(json.dumps(command_stop(args), indent=2))
        return 0
    if args.command_name == "list":
        print(json.dumps(command_list(args), indent=2))
        return 0
    if args.command_name == "resume":
        print(json.dumps(command_resume(args), indent=2))
        return 0
    if args.command_name == "_run":
        return command_run(args)

    parser.error(f"Unknown command: {args.command_name}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
