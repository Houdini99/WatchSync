#!/usr/bin/env python3
"""Tests for the resolver's SSRF gate.

Runs without yt-dlp installed (it is stubbed below) so it works on a bare host:
    python3 -m unittest discover -s resolver -v
"""

import io
import sys
import types
import unittest
import urllib.error
import urllib.request

# app.py imports yt_dlp at module scope; stub it so these tests need no deps.
if "yt_dlp" not in sys.modules:
    _stub = types.ModuleType("yt_dlp")
    _stub.YoutubeDL = object
    sys.modules["yt_dlp"] = _stub

import app  # noqa: E402


class SchemeGate(unittest.TestCase):
    """Only http(s) may ever reach a fetcher, regardless of ALLOW_PRIVATE_URLS."""

    def test_non_http_schemes_rejected(self):
        for url in ("file:///etc/passwd", "ftp://example.com/x", "gopher://a/",
                    "concat:a|b", "data:text/plain,hi", "//example.com/x",
                    "jar:http://x/!/y", ""):
            with self.subTest(url=url):
                self.assertFalse(app.url_host_allowed(url))

    def test_scheme_gate_applies_even_when_private_urls_allowed(self):
        original = app.ALLOW_PRIVATE_URLS
        app.ALLOW_PRIVATE_URLS = True
        try:
            self.assertFalse(app.url_host_allowed("file:///etc/passwd"))
            self.assertTrue(app.url_host_allowed("http://127.0.0.1/x"))
        finally:
            app.ALLOW_PRIVATE_URLS = original


class HostGate(unittest.TestCase):
    def test_internal_hosts_rejected(self):
        for url in ("http://127.0.0.1/x", "http://localhost/x",
                    "http://169.254.169.254/latest/meta-data/", "http://[::1]/x",
                    "http://0.0.0.0/x", "http://10.0.0.5/x", "http://192.168.1.1/x",
                    "http://172.16.0.1/x", "http://100.64.0.1/x"):
            with self.subTest(url=url):
                self.assertFalse(app.url_host_allowed(url))

    def test_public_hosts_allowed(self):
        for url in ("http://example.com/x", "https://www.youtube.com/watch?v=a"):
            with self.subTest(url=url):
                self.assertTrue(app.url_host_allowed(url))

    def test_ipv4_mapped_v6_is_unwrapped(self):
        self.assertFalse(app.url_host_allowed("http://[::ffff:127.0.0.1]/x"))


class RedirectGate(unittest.TestCase):
    """urllib follows redirects transparently; each hop must be re-gated."""

    def setUp(self):
        self.handler = app._SafeRedirectHandler()
        self.req = urllib.request.Request("https://example.com/a.vtt")

    def _redirect_to(self, newurl):
        return self.handler.redirect_request(
            self.req, io.BytesIO(b""), 302, "Found", {}, newurl)

    def test_redirect_to_internal_host_blocked(self):
        for target in ("http://127.0.0.1:3000/api/health",
                       "http://watchsync-server:3000/api/health",
                       "http://169.254.169.254/latest/meta-data/",
                       "file:///etc/passwd"):
            with self.subTest(target=target):
                with self.assertRaises(urllib.error.HTTPError):
                    self._redirect_to(target)

    def test_public_redirect_still_followed(self):
        self.assertIsNotNone(self._redirect_to("https://example.com/b.vtt"))


if __name__ == "__main__":
    unittest.main()
