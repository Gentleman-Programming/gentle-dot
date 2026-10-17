#!/usr/bin/python3
"""Durable real-Niri runtime runner (read-only preflight + opt-in exercise).

Never claims PASS overall; missing prerequisites are BLOCKED (nonzero), never
green. Pure GUI acceptance only via live run; fixture tests are supplementary.
"""
import argparse
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone

ROSE_TITLE = "Gentle Dot"
PANEL_TITLE = "Gentle Dot Panel"
FOLLOW_DEBOUNCE_MS = 300
# Bound: debounce + settle + latency. NOT <=300: 305 ms observed must pass.
FOLLOW_TIMEOUT_MS = 2000
SAFE_DX, SAFE_DY = 200, 80
HIDE_DX = 40
POLL_S = 0.05
# BLOCKED here never forces nonzero; only these missing prerequisites do.
REQUIRED = ("pid_identity", "niri_socket", "windows")


def stat_starttime(raw: bytes) -> str:
    tail = raw.rsplit(b")", 1)[1].split()
    val = tail[19].decode()
    if not val.isdigit():
        raise ValueError("bad starttime")
    return val


def exe_matches(actual: str, expected: str) -> bool:
    return actual == expected


def find_owned(windows, pid):
    rose = panel = None
    for w in windows:
        if not isinstance(w, dict) or w.get("pid") != pid:
            continue
        if w.get("title") == ROSE_TITLE and rose is None:
            rose = w
        elif w.get("title") == PANEL_TITLE and panel is None:
            panel = w
    return (rose, panel)


def pos_of(w):
    try:
        x, y = w["layout"]["tile_pos_in_workspace_view"]
        return (float(x), float(y))
    except (KeyError, TypeError, ValueError):
        return None


def panel_follows(r0, p0, r1, p1, tol=1.0):
    try:
        return (abs((p1[0] - r1[0]) - (p0[0] - r0[0])) <= tol
                and abs((p1[1] - r1[1]) - (p0[1] - r0[1])) <= tol)
    except (TypeError, IndexError):
        return False


def size_of(w):
    try:
        lay = w["layout"]
        for key in ("tile_size", "window_size"):
            s = lay.get(key)
            if s is not None:
                return (float(s[0]), float(s[1]))
    except (KeyError, TypeError, ValueError, IndexError):
        pass
    return None


def output_bounds(data):
    """Logical output rects from `niri msg --json outputs`. Raises ValueError
    when the schema is unvalidated: never guess bounds."""
    try:
        outs = data.values() if isinstance(data, dict) else data
        rects = [(float(o["logical"][x]), float(o["logical"][y]),
                  float(o["logical"]["width"]), float(o["logical"]["height"]))
                 for o in outs for x, y in (("x", "y"),)]
    except (AttributeError, KeyError, TypeError, ValueError):
        raise ValueError("unvalidated outputs schema")
    if not rects:
        raise ValueError("no outputs")
    return rects


def rect_fits(bounds, pos, size, dx, dy):
    tx, ty = (pos[0] + dx, pos[1] + dy)
    return any(tx >= bx and ty >= by and tx + size[0] <= bx + bw
               and ty + size[1] <= by + bh for (bx, by, bw, bh) in bounds)


def plan_legs(r_pos, r_size, bounds, dx=SAFE_DX, dy=SAFE_DY):
    """Same opposite pair, feasible order first; ValueError when neither
    target fits validated bounds (no edge guessing)."""
    if r_size is None:
        raise ValueError("unknown rose size")
    for (ax, ay) in ((dx, dy), (-dx, -dy)):
        if rect_fits(bounds, r_pos, r_size, ax, ay):
            return [(ax, ay), (-ax, -ay)]
    raise ValueError("no feasible move inside validated bounds")


def rose_moved(r_before, r_after, dx, dy, tol=1.0):
    """Actual displacement must match the commanded delta (absolute target).
    Offset equality alone is NOT motion evidence."""
    try:
        return (abs((r_after[0] - r_before[0]) - dx) <= tol
                and abs((r_after[1] - r_before[1]) - dy) <= tol)
    except (TypeError, IndexError):
        return False


def run_follow_leg(rose_id, panel_id, pid, r0, p0, dx, dy, query, move,
                   poll_s=POLL_S, deadline_ms=FOLLOW_TIMEOUT_MS):
    """One commanded move + settle poll. PASS needs: rose at commanded
    absolute target AND panel offset kept AND same IDs/PID AND in bound.
    Unchanged geometry timeouts FAIL; an unissued move is BLOCKED (can't PASS)."""
    try:
        move(rose_id, dx, dy)
    except Exception as e:
        return ("BLOCKED", "move not issued: %s" % e, r0, p0, 0.0, False)
    t0 = time.monotonic()
    last = (r0, p0)
    while (time.monotonic() - t0) * 1000 <= deadline_ms:
        time.sleep(poll_s)
        try:
            wins = query()
        except Exception:
            continue
        rose, panel = find_owned(wins, pid)
        if not (rose and panel and rose.get("id") == rose_id
                and panel.get("id") == panel_id):
            continue
        rn, pn = pos_of(rose), pos_of(panel)
        if not (rn and pn):
            continue
        last = (rn, pn)
        ms = (time.monotonic() - t0) * 1000
        if (rose_moved(r0, rn, dx, dy) and panel_follows(r0, p0, rn, pn)
                and follow_acceptable(ms)):
            return ("PASS", "rose reached target, panel offset kept",
                    rn, pn, ms, True)
    ms = (time.monotonic() - t0) * 1000
    rn, pn = last
    if not rose_moved(r0, rn, dx, dy):
        return ("FAIL", "no rose motion to commanded target: timeout",
                rn, pn, ms, True)
    return ("FAIL", "rose moved but panel offset not kept: timeout",
            rn, pn, ms, True)


def identity_holds(pid, exe, start):
    try:
        return read_proc(pid) == (exe, start)
    except (OSError, ValueError):
        return False


def restore_to_baseline(rose_id, pid, baseline, query, move, ident_ok):
    """Guarded restore: no action unless PID identity + rose id still ours.
    Reports its own PASS/FAIL/BLOCKED; never silent. No config mutations."""
    if not ident_ok():
        return ("BLOCKED", "restore skipped: PID identity changed (reuse guard)")
    try:
        wins = query()
    except Exception as e:
        return ("BLOCKED", "restore skipped: re-query failed: %s" % e)
    rose, _ = find_owned(wins, pid)
    cur = pos_of(rose) if (rose and rose.get("id") == rose_id) else None
    if cur is None:
        return ("BLOCKED", "restore skipped: rose id no longer ours")
    dx = int(round(baseline[0] - cur[0]))
    dy = int(round(baseline[1] - cur[1]))
    if abs(baseline[0] - cur[0]) <= 1.0 and abs(baseline[1] - cur[1]) <= 1.0:
        return ("PASS", "already at baseline; no action needed")
    try:
        move(rose_id, dx, dy)
    except Exception as e:
        return ("FAIL", "restore move failed: %s" % e)
    return ("PASS", "restore move issued: %+d,%+d" % (dx, dy))


def exercise_legs(rose_id, panel_id, pid, baseline, legs, query, move,
                  ident_ok, poll_s=POLL_S, deadline_ms=FOLLOW_TIMEOUT_MS):
    """Runs planned legs from live baseline; restores when displaced.
    Returns (legs_out, restore) with restore None only if nothing moved."""
    r0, p0 = baseline
    legs_out = {}
    names = ("leg1", "leg2")
    issued = False
    try:
        for name, (dx, dy) in zip(names, legs):
            st, det, rn, pn, ms, was = run_follow_leg(
                rose_id, panel_id, pid, r0, p0, dx, dy, query, move,
                poll_s=poll_s, deadline_ms=deadline_ms)
            issued = issued or was
            legs_out[name] = {"status": st, "detail": det,
                               "latency_ms": round(ms, 1)}
            r0, p0 = rn, pn
            if st != "PASS":
                break
    except Exception as e:
        legs_out.setdefault("leg1", {"status": "BLOCKED",
                                       "detail": "aborted: %s" % e})
    all_pass = all(v["status"] == "PASS" for v in legs_out.values())
    settled = (abs(r0[0] - baseline[0][0]) <= 1.0
               and abs(r0[1] - baseline[0][1]) <= 1.0)
    restore = None
    if issued and not (all_pass and settled):
        restore = restore_to_baseline(rose_id, pid, baseline[0], query, move,
                                      ident_ok)
    return (legs_out, restore)


def health_ok(raw: bytes) -> bool:
    return b" 200 " in raw.split(b"\r\n", 1)[0]


def follow_acceptable(ms: float) -> bool:
    return ms <= FOLLOW_TIMEOUT_MS


def summarize(checks: dict):
    vals = list(checks.values())
    if any(v == "FAIL" for v in vals):
        return ("FAIL", 1)
    if any(v == "BLOCKED" for v in vals):
        code = 2 if any(checks.get(k) == "BLOCKED" for k in REQUIRED) else 0
        return ("BLOCKED", code)
    return ("BLOCKED", 0)  # never "PASS": coverage gaps always listed BLOCKED


def run(cmd, timeout):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=timeout, check=False)


def query_windows():
    p = run(["niri", "msg", "--json", "windows"], 10)
    if p.returncode != 0:
        raise RuntimeError("niri msg windows failed")
    data = json.loads(p.stdout.decode("utf-8"))
    return data if isinstance(data, list) else data.get("windows", [])


def move_rose(win_id, dx, dy):
    p = run(["niri", "msg", "action", "move-floating-window", "--id", str(win_id),
             "--x", "%+d" % dx, "--y", "%+d" % dy], 10)
    if p.returncode != 0:
        raise RuntimeError("move-floating-window failed")


def query_outputs():
    p = run(["niri", "msg", "--json", "outputs"], 10)
    if p.returncode != 0:
        raise RuntimeError("niri msg outputs failed")
    return output_bounds(json.loads(p.stdout.decode("utf-8")))


def read_proc(pid):
    exe = os.readlink("/proc/%d/exe" % pid)
    with open("/proc/%d/stat" % pid, "rb") as f:
        start = stat_starttime(f.read(65536))
    return (exe, start)


def check_health(port, timeout_s=3):
    req = ("GET /health HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nConnection: close\r\n\r\n" % port).encode()
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout_s)
    try:
        s.sendall(req)
        return health_ok(s.recv(4096))
    finally:
        s.close()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--exe", required=True)
    ap.add_argument("--artifact-dir", required=True)
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--exercise-windows", action="store_true")
    a = ap.parse_args(argv)
    checks, details = {}, {}
    art = os.path.realpath(a.artifact_dir)
    if not (os.path.isdir(art) and (art == "/tmp" or art.startswith(("/tmp/", "/var/tmp/")))):
        print("artifact-dir must be an existing dir under /tmp or /var/tmp", file=sys.stderr)
        return 2
    exp_exe = os.path.realpath(a.exe)
    try:
        proc_exe, start = read_proc(a.pid)
        proc_exe = os.path.realpath(proc_exe)
    except (OSError, ValueError):
        checks["pid_identity"] = "BLOCKED"
        details["pid_identity"] = "cannot read /proc identity"
        proc_exe, start = None, None
    else:
        if not exe_matches(proc_exe, exp_exe):
            checks["pid_identity"] = "FAIL"
            details["pid_identity"] = "exe mismatch (PID reuse guard)"
        else:
            checks["pid_identity"] = "PASS"
            details["pid_identity"] = "exe+starttime verified"
    try:
        h = hashlib.sha256(open(exp_exe, "rb").read()).hexdigest()
    except OSError:
        h = "unreadable"
    sock = os.environ.get("NIRI_SOCKET", "")
    checks["niri_socket"] = "PASS" if sock and os.path.exists(sock) else "BLOCKED"
    details["niri_socket"] = "current NIRI_SOCKET present" if checks["niri_socket"] == "PASS" else "missing NIRI_SOCKET"
    rose = panel = None
    r0 = p0 = None
    total = None
    if checks["pid_identity"] == "PASS" and checks["niri_socket"] == "PASS":
        try:
            wins = query_windows()
            total = len(wins)
            rose, panel = find_owned(wins, a.pid)
            r0, p0 = pos_of(rose) if rose else None, pos_of(panel) if panel else None
            checks["windows"] = "PASS" if (r0 and p0) else "BLOCKED"
            details["windows"] = "rose+panel identified" if r0 and p0 else "rose/panel not identified"
        except (OSError, RuntimeError, ValueError):
            checks["windows"] = "BLOCKED"
            details["windows"] = "window query failed"
    else:
        checks["windows"] = "BLOCKED"
        details["windows"] = "skipped: identity/socket first"
    if a.port is None:
        checks["backend_health"] = "BLOCKED"
        details["backend_health"] = "not probed (no --port); never UI-ready"
    else:
        try:
            ok = check_health(a.port)
        except OSError:
            ok = False
        checks["backend_health"] = "PASS" if ok else "BLOCKED"
        details["backend_health"] = "backend-ready only, not UI" if ok else "backend not ready"
    for name in ("authenticated_ui", "first_frame", "modes", "tray", "login",
                 "rose_hide_pref", "recording"):
        checks[name] = "BLOCKED"
        details[name] = "not covered in this unit"
    follow = {}
    base_r, base_p = r0, p0
    if a.exercise_windows and all(checks.get(k) == "PASS" for k in REQUIRED):
        ident = lambda: identity_holds(a.pid, proc_exe, start)
        try:
            try:
                legs = plan_legs(base_r, size_of(rose), query_outputs())
            except (OSError, RuntimeError, ValueError) as e:
                for k in ("follow_leg1", "follow_leg2", "toggle_hide",
                          "hidden_no_remap"):
                    checks[k] = "BLOCKED"
                    details[k] = "bounds unvalidated, no move issued: %s" % e
                legs = None
            if legs is not None:
                legs_out, restore = exercise_legs(
                    rose["id"], panel["id"], a.pid, (base_r, base_p),
                    legs, query_windows, move_rose, ident)
                for leg, (dx, dy) in zip(("leg1", "leg2"), legs):
                    if leg in legs_out:
                        checks["follow_" + leg] = legs_out[leg]["status"]
                        details["follow_" + leg] = legs_out[leg]["detail"]
                        follow[leg] = {"delta": [dx, dy],
                                       "latency_ms": legs_out[leg]["latency_ms"],
                                       "status": legs_out[leg]["status"]}
                if restore is not None:
                    checks["restore"] = restore[0]
                    details["restore"] = restore[1]
            if all(checks.get(k) == "PASS" for k in ("follow_leg1", "follow_leg2")):
                run([exp_exe, "--toggle"], 15)
                time.sleep(1.0)
                w = find_owned(query_windows(), a.pid)
                hid = w[0] and w[0]["id"] == rose["id"] and pos_of(w[0])
                checks["toggle_hide"] = "PASS" if hid else "FAIL"
                details["toggle_hide"] = "rose survives hide" if hid else "rose lost on hide"
                if hid:
                    hp = pos_of(w[1]) if w[1] else None
                    move_rose(rose["id"], HIDE_DX, 0)
                    time.sleep((FOLLOW_DEBOUNCE_MS + 500) / 1000.0)
                    w2 = find_owned(query_windows(), a.pid)
                    p2 = pos_of(w2[1]) if w2[1] else None
                    ok = bool(p2 and hp and abs(p2[0] - hp[0]) <= 1.0
                              and abs(p2[1] - hp[1]) <= 1.0)
                    checks["hidden_no_remap"] = "PASS" if ok else "FAIL"
                    details["hidden_no_remap"] = ("panel unmoved while hidden"
                                                   if ok else "panel remapped while hidden")
                    if ident():
                        move_rose(rose["id"], -HIDE_DX, 0)
                    run([exp_exe, "--toggle"], 15)
        except (OSError, RuntimeError, ValueError) as e:
            for k in ("follow_leg1", "follow_leg2", "toggle_hide", "hidden_no_remap"):
                checks.setdefault(k, "BLOCKED")
                details.setdefault(k, "aborted: %s" % e)
            rb = restore_to_baseline(rose["id"], a.pid, base_r,
                                     query_windows, move_rose, ident)
            if checks.get("restore") != "FAIL":
                checks["restore"] = rb[0]
            details["restore"] = (details.get("restore", "") + "; post-error: "
                                   + rb[1]).strip("; ")
    elif a.exercise_windows:
        for k in ("follow_leg1", "follow_leg2", "toggle_hide", "hidden_no_remap"):
            checks[k] = "BLOCKED"
            details[k] = "skipped: preflight not green"
    overall, code = summarize(checks)
    ev = {"tool": "assert-niri", "pid": a.pid, "exe_expected": exp_exe,
          "exe_resolved": proc_exe, "exe_sha256": h, "proc_starttime": start,
          "niri_socket": sock if checks["niri_socket"] == "PASS" else None,
          "backend_port": a.port, "wall_time": datetime.now(timezone.utc).isoformat(),
          "monotonic": time.monotonic(), "window_count_total": total,
          "rose": {"id": rose["id"] if rose else None, "pos": r0},
          "panel": {"id": panel["id"] if panel else None, "pos": p0},
          "checks": {k: {"status": v, "detail": details.get(k, "")} for k, v in checks.items()},
          "follow": follow, "overall": overall}
    with open(os.path.join(art, "evidence.json"), "w", encoding="utf-8") as f:
        json.dump(ev, f, indent=2)
    for k, v in checks.items():
        print("%-16s %s" % (k, v))
    print("overall: " + overall)
    return code


if __name__ == "__main__":
    sys.exit(main())
