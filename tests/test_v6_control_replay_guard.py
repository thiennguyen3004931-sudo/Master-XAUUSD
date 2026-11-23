"""No-MT5 regression for V6 control API replay guard and browser wiring."""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parent.parent


@unittest.skipUnless(shutil.which("node"), "Node.js required for V6 replay tests")
class TestV6ControlReplayGuard(unittest.TestCase):
    def _node(self, code: str) -> None:
        result = subprocess.run(
            ["node", "--input-type=module", "--eval", code],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=35,
            check=False,
        )
        self.assertEqual(
            result.returncode, 0,
            f"Node replay test failed: {result.stderr}\n{result.stdout}",
        )

    def test_missing_and_malformed_mutation_headers_fail_closed(self) -> None:
        self._node(r"""
          import assert from "node:assert/strict";
          import { createV6ReplayGuard } from "./scripts/v6-control-replay-guard.mjs";
          const now = 1795414800000;
          const guard = createV6ReplayGuard({now: () => now});
          const validNonce = "0123456789abcdef0123456789abcdef";
          const req = (method, headers={}) => ({method,headers});
          assert.equal(guard(req("POST")).error, "REPLAY_HEADERS_REQUIRED");
          assert.equal(guard(req("POST", {"x-v6-nonce":validNonce})).error, "REPLAY_HEADERS_REQUIRED");
          assert.equal(guard(req("POST", {"x-v6-nonce": validNonce, "x-v6-timestamp":"NaN"})).error, "REPLAY_HEADERS_MALFORMED");
          assert.equal(guard(req("POST", {"x-v6-nonce":"short", "x-v6-timestamp":String(now)})).error, "REPLAY_HEADERS_MALFORMED");
          assert.equal(guard(req("POST", {"x-v6-nonce":[validNonce], "x-v6-timestamp":String(now)})).error, "REPLAY_HEADERS_REQUIRED");
          assert.equal(guard(req("POST", {"x-v6-nonce":validNonce, "x-v6-timestamp":[String(now)]})).error, "REPLAY_HEADERS_REQUIRED");
          assert.equal(guard(req("PUT")).error, "REPLAY_HEADERS_REQUIRED");
          assert.equal(guard(req("PATCH")).error, "REPLAY_HEADERS_REQUIRED");
          assert.equal(guard(req("DELETE")).error, "REPLAY_HEADERS_REQUIRED");
          assert.equal(guard(req("GET")).ok, true);
          assert.equal(guard(req("HEAD")).ok, true);
          assert.equal(guard(req("OPTIONS")).ok, true);
        """)

    def test_duplicate_nonce_and_expired_timestamp_blocked(self) -> None:
        self._node(r"""
          import assert from "node:assert/strict";
          import { createV6ReplayGuard } from "./scripts/v6-control-replay-guard.mjs";
          let now = 1795414800000;
          const guard = createV6ReplayGuard({now: () => now});
          const nonce = "abcdefabcdefabcdefabcdefabcdefab";
          const headers = (n,t) => ({"x-v6-nonce":n, "x-v6-timestamp":String(t)});
          assert.equal(guard({method:"POST",headers:headers(nonce,now)}).ok,true);
          assert.equal(guard({method:"POST",headers:headers(nonce.toUpperCase(),now)}).error,"REPLAY_DETECTED");
          assert.equal(guard({method:"POST",headers:headers("00000000000000000000000000000001",now-300001)}).error,"REQUEST_TIMESTAMP_EXPIRED");
          assert.equal(guard({method:"POST",headers:headers("00000000000000000000000000000002",now+300001)}).error,"REQUEST_TIMESTAMP_EXPIRED");
          assert.equal(guard({method:"POST",headers:headers("00000000000000000000000000000003",now)}).ok,true);
          now += 2 * 300000 + 1;
          assert.equal(guard({method:"POST",headers:headers(nonce,now)}).ok,true);
        """)

    def test_bounded_cache_fails_closed_not_overwrites_old_nonce(self) -> None:
        self._node(r"""
          import assert from "node:assert/strict";
          import { createV6ReplayGuard, V6_REPLAY_NONCE_LIMIT } from "./scripts/v6-control-replay-guard.mjs";
          const now = 1795414800000;
          const guard = createV6ReplayGuard({now: () => now});
          for (let i=0;i<V6_REPLAY_NONCE_LIMIT;i++) {
            assert.equal(guard({
              method:"POST",
              headers:{"x-v6-nonce":i.toString(16).padStart(32,"0"),"x-v6-timestamp":String(now)}
            }).ok,true);
          }
          const reject=guard({method:"POST",headers:{"x-v6-nonce":"ffffffffffffffffffffffffffffffff","x-v6-timestamp":String(now)}});
          assert.equal(reject.ok,false);
          assert.equal(reject.error,"REPLAY_GUARD_CAPACITY_REACHED");
          assert.equal(guard({method:"POST",headers:{"x-v6-nonce":"00000000000000000000000000000000","x-v6-timestamp":String(now)}}).error,"REPLAY_DETECTED");
        """)

    def test_real_api_and_both_browser_clients_require_replay_headers(self) -> None:
        server = (ROOT / "scripts" / "xauusd-standalone-server.mjs").read_text(encoding="utf8")
        self.assertIn('import { createV6ReplayGuard }', server)
        self.assertIn("export const verifyReplayGuard = createV6ReplayGuard();", server)
        self.assertIn("const replayRes = verifyReplayGuard(req);", server)
        self.assertNotIn("V6_STRICT_REPLAY_GUARD", server)
        for path in (
            "apps/web/public/standalone-ui.html",
            "MO_WEB_TRUC_TIEP_KHONG_CAN_SERVER.html",
        ):
            content = (ROOT / path).read_text(encoding="utf8")
            self.assertIn('headers.set("x-v6-nonce"', content)
            self.assertIn('headers.set("x-v6-timestamp"', content)
            self.assertIn("window.crypto.getRandomValues(nonceBytes)", content)
            self.assertIn('if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS")', content)
            self.assertIn('originalFetch(base + "/api/v1/auth-pair"', content)


if __name__ == "__main__":
    unittest.main()
