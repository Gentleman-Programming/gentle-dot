"""Fixture tests for assert-niri.py (supplementary only, never GUI acceptance)."""
import importlib.util
import unittest

SPEC = importlib.util.spec_from_file_location(
    "assert_niri", "scripts/linux/niri/assert-niri.py")
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class ParserTest(unittest.TestCase):
    def test_filter_exact_pid_title(self):
        wins = [
            {"id": 1, "title": "Gentle Dot", "pid": 111,
             "layout": {"tile_pos_in_workspace_view": [1.0, 2.0]}},
            {"id": 2, "title": "Gentle Dot", "pid": 999,
             "layout": {"tile_pos_in_workspace_view": [9.0, 9.0]}},
            {"id": 3, "title": "gentle dot", "pid": 111,
             "layout": {"tile_pos_in_workspace_view": [3.0, 3.0]}},
            {"id": 4, "title": "Gentle Dot Panel", "pid": 111,
             "layout": {"tile_pos_in_workspace_view": [5.0, 6.0]}},
            {"id": 5, "title": "Gentle Dot Panel ", "pid": 111,
             "layout": {"tile_pos_in_workspace_view": [7.0, 8.0]}},
        ]
        rose, panel = mod.find_owned(wins, 111)
        self.assertEqual((rose["id"], panel["id"]), (1, 4))

    def test_stat_starttime_paren_comm(self):
        raw = b"7 (my app v2 (x)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 555 20 21"
        self.assertEqual(mod.stat_starttime(raw), "555")

    def test_pid_guard_rejects(self):
        self.assertFalse(mod.exe_matches("/a/b", "/other/b"))
        self.assertFalse(mod.exe_matches("/a/b", "/a/b "))
        self.assertTrue(mod.exe_matches("/a/b", "/a/b"))


class ReportTest(unittest.TestCase):
    def test_missing_socket_never_green(self):
        overall, code = mod.summarize({"pid_identity": "PASS", "niri_socket": "BLOCKED"})
        self.assertEqual(overall, "BLOCKED")
        self.assertNotEqual(code, 0)

    def test_no_overall_pass_string(self):
        overall, code = mod.summarize({"pid_identity": "PASS", "niri_socket": "PASS",
                                       "windows": "PASS", "first_frame": "BLOCKED"})
        self.assertNotEqual(overall, "PASS")
        self.assertEqual(code, 0)

    def test_fail_beats_blocked(self):
        overall, code = mod.summarize({"a": "BLOCKED", "b": "FAIL"})
        self.assertEqual((overall, code), ("FAIL", 1))

    def test_follow_math_and_threshold(self):
        self.assertGreater(mod.FOLLOW_TIMEOUT_MS, 305)
        self.assertTrue(mod.follow_acceptable(305))
        self.assertTrue(mod.panel_follows((0.0, 0.0), (10.0, 10.0),
                                          (200.0, 80.0), (210.0, 90.0)))
        self.assertFalse(mod.panel_follows((0.0, 0.0), (10.0, 10.0),
                                           (200.0, 80.0), (999.0, 90.0)))

    def test_health_never_implies_ui(self):
        self.assertTrue(mod.health_ok(b"HTTP/1.1 200 OK\r\n\r\n{}"))
        self.assertFalse(mod.health_ok(b"HTTP/1.1 403 Forbidden\r\n\r\n"))
        overall, _ = mod.summarize({"backend_health": "PASS",
                                    "authenticated_ui": "BLOCKED"})
        self.assertEqual(overall, "BLOCKED")


class _FakeNiri:
    """Stateful mock compositor: move() records and optionally applies; query()
    serves current geometry, applying pending panel follow after a delay."""
    def __init__(self, pid=4242, rpos=(100.0, 100.0), xpos=(0.0, 0.0),
                 follow_delay=0, apply=True, wrong=None):
        self.pid = pid
        self.rpos = [float(rpos[0]), float(rpos[1])]
        self.xpos = [float(xpos[0]), float(xpos[1])]
        self.moves = []
        self.n = 0
        self.follow_delay = follow_delay
        self.apply = apply
        self.wrong = wrong
        self._pending = None

    def move(self, wid, dx, dy):
        self.moves.append((wid, dx, dy))
        if self.apply:
            ax, ay = self.wrong if self.wrong is not None else (dx, dy)
            self.rpos = [self.rpos[0] + ax, self.rpos[1] + ay]
            self._pending = (ax, ay)

    def query(self):
        self.n += 1
        if self._pending is not None and self.n > self.follow_delay:
            ax, ay = self._pending
            self.xpos = [self.xpos[0] + ax, self.xpos[1] + ay]
            self._pending = None
        return [
            {"id": 11, "title": "Gentle Dot", "pid": self.pid,
             "layout": {"tile_pos_in_workspace_view": list(self.rpos),
                          "tile_size": [72.0, 72.0]}},
            {"id": 12, "title": "Gentle Dot Panel", "pid": self.pid,
             "layout": {"tile_pos_in_workspace_view": list(self.xpos),
                          "tile_size": [420.0, 640.0]}},
        ]


class OrchestratorTest(unittest.TestCase):
    KW = {"poll_s": 0.005, "deadline_ms": 150}

    def leg(self, fake, dx=200, dy=80, r0=(100.0, 100.0), p0=(0.0, 0.0)):
        return mod.run_follow_leg(11, 12, fake.pid, r0, p0, dx, dy,
                                  fake.query, fake.move, **self.KW)

    def test_no_motion_must_timeout_fail(self):
        fake = _FakeNiri(apply=False)  # compositor ignores the move
        st, det, _rn, _pn, _ms, issued = self.leg(fake)
        self.assertTrue(issued, "move must have been requested")
        self.assertEqual(st, "FAIL")
        self.assertIn("no rose motion", det)

    def test_pass_needs_target_and_offset(self):
        fake = _FakeNiri(follow_delay=2)
        st, _det, rn, _pn, ms, _issued = self.leg(fake)
        self.assertEqual(st, "PASS")
        self.assertAlmostEqual(rn[0], 300.0)
        self.assertAlmostEqual(rn[1], 180.0)
        self.assertTrue(mod.follow_acceptable(ms))

    def test_wrong_target_fails(self):
        fake = _FakeNiri(follow_delay=0, wrong=(100, 40))
        self.assertEqual(self.leg(fake)[0], "FAIL")

    def test_static_panel_fails(self):
        fake = _FakeNiri(follow_delay=10 ** 9)  # rose moves, panel never does
        st, det, _rn, _pn, _ms, _issued = self.leg(fake)
        self.assertEqual(st, "FAIL")
        self.assertIn("panel offset", det)

    def test_unissued_move_cannot_pass(self):
        def move(_w, _x, _y):
            raise RuntimeError("niri action failed")
        st, _det, _rn, _pn, _ms, issued = mod.run_follow_leg(
            11, 12, 4242, (100.0, 100.0), (0.0, 0.0), 200, 80,
            _FakeNiri().query, move, **self.KW)
        self.assertEqual(st, "BLOCKED")
        self.assertFalse(issued)

    def test_bounds_gate(self):
        out = {"DP-1": {"logical": {"x": 0, "y": 0, "width": 2560,
                                        "height": 1440}}}
        bounds = mod.output_bounds(out)
        self.assertEqual(bounds, [(0.0, 0.0, 2560.0, 1440.0)])
        self.assertEqual(mod.plan_legs((100.0, 100.0), (72.0, 72.0), bounds),
                         [(200, 80), (-200, -80)])
        # +200 overflows the right edge: swapped order, same pair.
        self.assertEqual(mod.plan_legs((2500.0, 100.0), (72.0, 72.0), bounds),
                         [(-200, -80), (200, 80)])
        with self.assertRaises(ValueError):
            mod.plan_legs((10.0, 10.0), (72.0, 72.0), [(0.0, 0.0, 100.0, 100.0)])
        with self.assertRaises(ValueError):
            mod.output_bounds({"DP-1": {"modes": []}})

    def test_leg2_failure_restores_current_delta(self):
        fake = _FakeNiri(follow_delay=0)
        calls = {"n": 0}
        real_move = fake.move

        def flaky(wid, dx, dy):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("second action refused")
            real_move(wid, dx, dy)
        legs_out, restore = mod.exercise_legs(
            11, 12, fake.pid, ((100.0, 100.0), (0.0, 0.0)),
            [(200, 80), (-200, -80)], fake.query, flaky, lambda: True,
            **self.KW)
        self.assertEqual(legs_out["leg2"]["status"], "BLOCKED")
        self.assertIsNotNone(restore)
        self.assertEqual(restore[0], "PASS")
        # Current-delta restore: rose sits at +200,+80, so inverse issued.
        self.assertEqual(fake.moves[-1], (11, -200, -80))

    def test_pid_reuse_issues_no_action(self):
        fake = _FakeNiri()
        st, det = mod.restore_to_baseline(
            11, fake.pid, (100.0, 100.0), fake.query, fake.move,
            lambda: False)
        self.assertEqual(st, "BLOCKED")
        self.assertIn("reuse", det)
        self.assertEqual(fake.moves, [])

    def test_restore_failure_is_reported(self):
        fake = _FakeNiri()
        fake.rpos = [300.0, 180.0]  # displaced from baseline

        def boom(_w, _x, _y):
            raise RuntimeError("no socket")
        st, det = mod.restore_to_baseline(
            11, fake.pid, (100.0, 100.0), fake.query, boom, lambda: True)
        self.assertEqual(st, "FAIL")
        self.assertTrue(det)

    def test_identity_holds(self):
        self.assertFalse(mod.identity_holds(2 ** 30, "/x", "1"))
        self.assertFalse(mod.identity_holds(1, "/definitely/not-ours", "0"))


if __name__ == "__main__":
    unittest.main()
