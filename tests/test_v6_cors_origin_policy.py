"""No-server V6 CORS tests: exercise actual imported origin policy in Node."""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parent.parent


@unittest.skipUnless(shutil.which("node"), "Node.js required for CORS policy tests")
class V6CorsOriginPolicy(unittest.TestCase):
    def _run(self, javascript: str) -> None:
        process = subprocess.run(
            ["node", "--input-type=module", "--eval", javascript],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(
            process.returncode,
            0,
            f"Node policy test failed (exit={process.returncode}): {process.stderr}",
        )

    def test_exact_loopback_origins_default_and_custom_ports(self) -> None:
        self._run(r"""
            import assert from "node:assert/strict";
            import { resolveAllowedOriginValue as policy } from "./scripts/v6-api-cors-origin-policy.mjs";
            assert.equal(policy("http://localhost:5717"), "http://localhost:5717");
            assert.equal(policy("http://127.0.0.1:3711"), "http://127.0.0.1:3711");
            assert.equal(policy("http://localhost:3711"), "http://localhost:3711");
            assert.equal(policy("http://127.0.0.1:5717"), "http://127.0.0.1:5717");
            assert.equal(policy("http://localhost:6000", {webPort: 6000, apiPort: 6001}), "http://localhost:6000");
            assert.equal(policy("http://localhost:6001", {webPort: 6000, apiPort: 6001}), "http://localhost:6001");
            assert.equal(policy("http://localhost:5717", {webPort: 6000, apiPort: 6001}), null);
            assert.equal(policy("http://localhost:65536", {webPort: 65536, apiPort: 70000}), null);
        """)

    def test_refuse_arbitrary_ports_tunnel_reflections_and_lookalikes(self) -> None:
        self._run(r"""
            import assert from "node:assert/strict";
            import { resolveAllowedOriginValue as policy } from "./scripts/v6-api-cors-origin-policy.mjs";
            for (const origin of [
              "", null, "null", "*", "http://localhost:3000",
              "http://127.0.0.1:9000", "https://unsafe.trycloudflare.com",
              "https://unsafe.trycloudflare.com.evil.org",
              "http://localhost:5717.evil.org", "http://localhost:5717@evil.org",
              "http://127.0.0.1:5717/foo", "http://127.0.0.1:5717?x=y",
              "http://127.0.0.1:5717#hash", "file:///etc/passwd",
              "http://127.0.0.1:5717,https://evil.org", "http://[::1]:5717",
              "http://localhost:80", "http://localhost:3711 /xyz",
              "http://127.0.0.1:3711\\nX-Injected: yes",
            ]) {
              assert.equal(policy(origin), null, String(origin));
            }
        """)

    def test_owner_exact_https_remote_allowlist_only(self) -> None:
        self._run(r"""
            import assert from "node:assert/strict";
            import { resolveAllowedOriginValue as policy } from "./scripts/v6-api-cors-origin-policy.mjs";
            const configuredOrigins = "https://owner.trycloudflare.com, https://v6.example.org, http://192.168.1.3:5717, http://localhost:3001, *";
            const opts = {configuredOrigins};
            assert.equal(policy("https://owner.trycloudflare.com", opts), "https://owner.trycloudflare.com");
            assert.equal(policy("https://v6.example.org", opts), "https://v6.example.org");
            assert.equal(policy("http://localhost:3001", opts), "http://localhost:3001");
            assert.equal(policy("http://192.168.1.3:5717", opts), null);
            assert.equal(policy("https://other.trycloudflare.com", opts), null);
            assert.equal(policy("https://owner.trycloudflare.com.evil.org", opts), null);
            assert.equal(policy("https://v6.example.org.evil.org", opts), null);
        """)

    def test_actual_v6_api_cors_headers_and_preflight_are_wired(self) -> None:
        source = (ROOT / "scripts" / "xauusd-standalone-server.mjs").read_text(
            encoding="utf-8"
        )
        self.assertIn('import { resolveAllowedOriginValue }', source)
        self.assertIn('configuredOrigins: process.env.V6_ALLOWED_ORIGINS || ""', source)
        self.assertIn("if (!corsOrigin) {", source)
        self.assertIn("res.writeHead(403,", source)
        self.assertIn('...(corsOrigin ? { "access-control-allow-origin": corsOrigin } : {})', source)
        self.assertNotIn('origin.endsWith(".trycloudflare.com")', source)
        self.assertNotIn('origin.startsWith("http://localhost:")', source)
        self.assertIn('"vary": "Origin"', source)


if __name__ == "__main__":
    unittest.main()
