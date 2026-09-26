//! Media classification and (best-effort) title resolution.
//!
//! `detect_media` turns a pasted URL into a typed `Media`. YouTube links are
//! first-class (id + start-time extraction); `.m3u8` is HLS; common video
//! extensions and everything else fall through to a native `<video>` source.
//! Titles for YouTube are resolved asynchronously via the public oEmbed
//! endpoint and cached.

use crate::protocol::Media;
use std::collections::HashMap;
use std::time::Duration;
use url::Url;

const YT_HOSTS: &[&str] = &[
    "youtu.be",
    "www.youtu.be",
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
];

const TITLE_CACHE_MAX: usize = 500;
const TITLE_FETCH_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_TITLE_LEN: usize = 200;

/// A tiny FIFO-evicting cache of `videoId -> title`.
#[derive(Default)]
pub struct TitleCache {
    map: HashMap<String, String>,
    order: Vec<String>,
}

impl TitleCache {
    pub fn get(&self, id: &str) -> Option<String> {
        self.map.get(id).cloned()
    }

    pub fn put(&mut self, id: String, title: String) {
        if let Some(existing) = self.map.get_mut(&id) {
            *existing = title;
            return;
        }
        if self.order.len() >= TITLE_CACHE_MAX {
            if let Some(oldest) = self.order.first().cloned() {
                self.order.remove(0);
                self.map.remove(&oldest);
            }
        }
        self.order.push(id.clone());
        self.map.insert(id, title);
    }
}

/// Classify a raw URL into a `Media`. Returns `None` only when the input does
/// not parse as a URL — otherwise it always produces a best-effort `file`.
pub fn detect_media(raw_url: &str, cache: &TitleCache) -> Option<Media> {
    let url = Url::parse(raw_url).ok()?;
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();

    if YT_HOSTS.contains(&host.as_str()) {
        if let Some(id) = extract_youtube_id(&url) {
            let title = cache.get(&id).unwrap_or_else(|| raw_url.to_string());
            // A canonical `/live/<id>` URL is always a live stream; other YouTube
            // URL forms (`watch?v=`, `youtu.be/…`) can't be told apart here.
            let is_live = url
                .path_segments()
                .and_then(|mut s| s.next())
                .map(|first| first.eq_ignore_ascii_case("live"))
                .unwrap_or(false);
            return Some(Media {
                kind: "youtube".to_string(),
                id: Some(id),
                source: raw_url.to_string(),
                start: extract_start_seconds(&url),
                title,
                is_live,
            });
        }
    }

    // Resolved HLS URLs often carry signing query strings, so match ".m3u8"
    // anywhere in the URL, not just at the end of the path.
    let path = url.path().to_ascii_lowercase();
    if path.ends_with(".m3u8") || raw_url.to_ascii_lowercase().contains(".m3u8") {
        return Some(Media {
            kind: "hls".to_string(),
            id: None,
            source: raw_url.to_string(),
            start: 0.0,
            title: pretty_title(&url),
            is_live: false,
        });
    }

    // .mp4/.webm/.ogg/.mov/.mkv all map to `file`; so does anything unknown.
    Some(Media {
        kind: "file".to_string(),
        id: None,
        source: raw_url.to_string(),
        start: 0.0,
        title: pretty_title(&url),
        is_live: false,
    })
}

/// Whether a URL points straight at a playable media file/stream (so the HLS
/// proxy can feed it to ffmpeg as a single input without a yt-dlp resolver hop).
/// Generic page URLs (Vimeo/Twitch/Reddit/…) return `false` and go via the
/// resolver. Mirrors the extension set the frontend recognizes.
pub fn is_direct_media_url(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or(lower.as_str());
    const EXTS: &[&str] = &[
        ".mp4", ".webm", ".ogg", ".ogv", ".mov", ".mkv", ".m4v", ".m3u8", ".ts", ".aac", ".mp3",
    ];
    EXTS.iter().any(|e| path.ends_with(e)) || lower.contains(".m3u8")
}

/// Honour `?t=90`, `?t=1m30s`, or `?start=90` so a deep link starts where it
/// points. Capped at 24h.
fn extract_start_seconds(url: &Url) -> f64 {
    let raw = url
        .query_pairs()
        .find(|(k, _)| k == "t" || k == "start")
        .map(|(_, v)| v.into_owned());
    let Some(raw) = raw else { return 0.0 };
    parse_start_param(&raw)
}

/// The value half of `?t=` / `?start=`, split out so it is directly testable.
fn parse_start_param(raw: &str) -> f64 {
    if let Ok(n) = raw.parse::<u64>() {
        return n.min(86400) as f64;
    }

    // Parse an optional "<h>h<m>m<s>s" form.
    let mut secs: u64 = 0;
    let mut num = String::new();
    for c in raw.chars() {
        if c.is_ascii_digit() {
            num.push(c);
        } else {
            // Saturating throughout: `?t=99999999999999999h` overflows u64.
            // The release profile sets no overflow-checks so that wrapped
            // silently, but a debug/test build panicked inside the WebSocket
            // handler task (detect_media runs from on_change_video/on_queue_add).
            let val: u64 = num.parse().unwrap_or(0);
            num.clear();
            match c.to_ascii_lowercase() {
                'h' => secs = secs.saturating_add(val.saturating_mul(3600)),
                'm' => secs = secs.saturating_add(val.saturating_mul(60)),
                's' => secs = secs.saturating_add(val),
                _ => {}
            }
        }
    }
    secs.min(86400) as f64
}

fn extract_youtube_id(url: &Url) -> Option<String> {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "youtu.be" || host == "www.youtu.be" {
        return url
            .path()
            .trim_start_matches('/')
            .split('/')
            .next()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
    }
    if url.path() == "/watch" {
        return url
            .query_pairs()
            .find(|(k, _)| k == "v")
            .map(|(_, v)| v.into_owned());
    }
    let parts: Vec<&str> = url.path().split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 && matches!(parts[0], "embed" | "shorts" | "v" | "live") {
        return Some(parts[1].to_string());
    }
    None
}

/// Derive a human-ish title from the last path segment (or the host).
fn pretty_title(url: &Url) -> String {
    let base = url
        .path_segments()
        .and_then(|mut segs| segs.rfind(|s| !s.is_empty()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| url.host_str().unwrap_or("video").to_string());
    percent_decode(&base)
}

/// Minimal percent-decoding for display titles.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `true` when `raw_url`'s host resolves (only) to addresses that are safe to
/// fetch server-side. Fails closed: unparseable URLs, unresolvable hosts, and
/// any private/loopback/link-local/CGNAT/multicast answer all return `false` —
/// user-pasted URLs are fetched by ffmpeg/yt-dlp from inside the Docker
/// network, so this is the SSRF gate (see `Config::allow_private_urls`).
/// Redirects issued *after* this check are out of scope.
pub async fn is_public_target(raw_url: &str) -> bool {
    let Ok(url) = Url::parse(raw_url) else { return false };
    let Some(host) = url.host_str() else { return false };
    let port = url.port_or_known_default().unwrap_or(443);
    let Ok(addrs) = tokio::net::lookup_host((host, port)).await else {
        return false;
    };
    let mut any = false;
    for addr in addrs {
        any = true;
        if !ip_is_public(addr.ip()) {
            return false;
        }
    }
    any
}

fn ip_is_public(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => ipv4_is_public(v4),
        std::net::IpAddr::V6(v6) => {
            let segs = v6.segments();
            // Reject all of ::/96 — the deprecated "IPv4-compatible" block —
            // before any v4 unwrapping, and reject it wholesale rather than
            // just its named members. It contains `::1` (loopback) and `::`
            // (unspecified), and `to_ipv4()` turns `::1` into `0.0.0.1`, which
            // passes every IPv4 rule below. That was a live bypass: a hostname
            // with an AAAA record of ::1 reached ffmpeg.
            if segs[..6].iter().all(|&s| s == 0) {
                return false;
            }
            // Only IPv4-*mapped* (::ffff:0:0/96, i.e. segs[5] == 0xffff)
            // denotes a real IPv4 target, so it alone follows the IPv4 rules.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ipv4_is_public(v4);
            }
            // Each range is matched at its real prefix length. Matching on
            // segs[0] alone would be far too broad here: 2001::/16 holds a
            // great deal of ordinary public space (Google's public DNS at
            // 2001:4860::, HE tunnels at 2001:470::, …), and only 2001::/23
            // and 2001:db8::/32 inside it are actually reserved.
            let seg0 = segs[0];
            !(v6.is_multicast()
                || (seg0 & 0xfe00) == 0xfc00                    // unique local fc00::/7
                || (seg0 & 0xffc0) == 0xfe80                    // link local fe80::/10
                || (seg0 == 0x0064 && segs[1] == 0xff9b)        // NAT64 64:ff9b::/32
                || (seg0 == 0x0100 && segs[1] == 0
                    && segs[2] == 0 && segs[3] == 0)            // discard-only 100::/64
                || (seg0 == 0x2001 && (segs[1] & 0xfe00) == 0)  // IETF protocol 2001::/23
                || (seg0 == 0x2001 && segs[1] == 0x0db8))       // documentation 2001:db8::/32
        }
    }
}

fn ipv4_is_public(v4: std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    // Kept deliberately in step with the resolver's Python guard
    // (resolver/app.py:_ip_is_internal), which leans on ipaddress's
    // is_private/is_reserved. Divergence between the two is how one of them
    // silently becomes the weak link — see the tests below.
    !(v4.is_loopback()
        || v4.is_unspecified()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_multicast()
        || o[0] == 0                                        // "this network" 0.0.0.0/8
        || (o[0] == 100 && (o[1] & 0xc0) == 64)             // CGNAT 100.64.0.0/10
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)          // IETF protocol 192.0.0.0/24
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)          // TEST-NET-1 192.0.2.0/24
        || (o[0] == 198 && (o[1] & 0xfe) == 18)             // benchmarking 198.18.0.0/15
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)       // TEST-NET-2 198.51.100.0/24
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)        // TEST-NET-3 203.0.113.0/24
        || o[0] >= 240) // reserved 240.0.0.0/4 (incl. 255.255.255.255)
}

/// Fetch a YouTube title via the public oEmbed endpoint. Returns `None` on any
/// error or timeout.
pub async fn fetch_youtube_title(client: &reqwest::Client, source: &str) -> Option<String> {
    let endpoint = format!(
        "https://www.youtube.com/oembed?url={}&format=json",
        urlencoding_encode(source)
    );
    let resp = client
        .get(&endpoint)
        .timeout(TITLE_FETCH_TIMEOUT)
        .header("User-Agent", "WatchSync/3.0")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    let title = data.get("title")?.as_str()?.trim();
    if title.is_empty() {
        None
    } else {
        Some(title.chars().take(MAX_TITLE_LEN).collect())
    }
}

/// Percent-encode a URL for safe inclusion as a query-string value.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn v6(s: &str) -> IpAddr {
        IpAddr::V6(s.parse::<Ipv6Addr>().unwrap())
    }
    fn v4(s: &str) -> IpAddr {
        IpAddr::V4(s.parse::<Ipv4Addr>().unwrap())
    }

    /// Regression: `Ipv6Addr::to_ipv4()` converts IPv4-*compatible* ::/96 too,
    /// so `::1` became `0.0.0.1` and passed every IPv4 rule. A hostname with an
    /// AAAA record of ::1 reached ffmpeg.
    #[test]
    fn ipv6_compatible_range_is_not_unwrapped_to_public_ipv4() {
        assert!(!ip_is_public(v6("::1")), "::1 (loopback) must be rejected");
        assert!(!ip_is_public(v6("::")), ":: (unspecified) must be rejected");
        assert!(!ip_is_public(v6("::2")), "::/96 must not unwrap to public IPv4");
        assert!(!ip_is_public(v6("::0.0.0.2")), "::/96 written as v4 must be rejected");
    }

    #[test]
    fn ipv4_mapped_v6_follows_ipv4_rules() {
        assert!(!ip_is_public(v6("::ffff:127.0.0.1")));
        assert!(!ip_is_public(v6("::ffff:10.0.0.5")));
        assert!(!ip_is_public(v6("::ffff:169.254.169.254")));
        assert!(ip_is_public(v6("::ffff:8.8.8.8")));
    }

    #[test]
    fn ipv6_internal_ranges_rejected() {
        for addr in ["fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "64:ff9b::1"] {
            assert!(!ip_is_public(v6(addr)), "{addr} must be rejected");
        }
    }

    /// Guards against over-blocking: 2001::/16 is mostly ordinary public space,
    /// and only 2001::/23 and 2001:db8::/32 inside it are reserved. Matching
    /// the whole /16 would blackhole Google public DNS, HE tunnels and more.
    #[test]
    fn ipv6_public_allowed() {
        for addr in [
            "2606:4700:4700::1111",      // Cloudflare
            "2a00:1450:4001:80f::200e",  // Google
            "2001:4860:4860::8888",      // Google public DNS — inside 2001::/16
            "2001:470:1f0b::1",          // Hurricane Electric — inside 2001::/16
        ] {
            assert!(ip_is_public(v6(addr)), "{addr} must be allowed");
        }
    }

    #[test]
    fn ipv6_reserved_subranges_of_2001_rejected() {
        assert!(!ip_is_public(v6("2001::1")), "Teredo 2001::/32");
        assert!(!ip_is_public(v6("2001:1ff::1")), "IETF protocol 2001::/23 upper edge");
        assert!(!ip_is_public(v6("2001:db8::1")), "documentation 2001:db8::/32");
        assert!(!ip_is_public(v6("64:ff9b::1")), "NAT64");
        assert!(!ip_is_public(v6("100::1")), "discard-only");
    }

    /// These ranges are what the resolver's Python guard already covered via
    /// `is_reserved`/`is_private`; the Rust side used to miss them.
    #[test]
    fn ipv4_internal_and_reserved_ranges_rejected() {
        for addr in [
            "127.0.0.1", "0.0.0.0", "0.1.2.3", "10.0.0.5", "172.16.0.1",
            "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.0.1",
            "192.0.2.1", "198.18.0.1", "198.19.255.254", "198.51.100.1",
            "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
        ] {
            assert!(!ip_is_public(v4(addr)), "{addr} must be rejected");
        }
    }

    #[test]
    fn ipv4_public_allowed() {
        for addr in ["8.8.8.8", "1.1.1.1", "142.250.185.78", "99.99.99.99"] {
            assert!(ip_is_public(v4(addr)), "{addr} must be allowed");
        }
    }

    #[test]
    fn timestamp_parsing_saturates_instead_of_overflowing() {
        // Panicked in debug builds before this; the cap is 86400 either way.
        assert_eq!(parse_start_param("99999999999999999h"), 86400.0);
        assert_eq!(parse_start_param("18446744073709551615s"), 86400.0);
        assert_eq!(parse_start_param("1h2m3s"), 3723.0);
        assert_eq!(parse_start_param("90"), 90.0);
        assert_eq!(parse_start_param(""), 0.0);
    }

    /// 100.64.0.0/10 is CGNAT; 100.0.0.0/8 outside it is ordinary public space.
    #[test]
    fn cgnat_boundaries() {
        assert!(!ip_is_public(v4("100.64.0.0")));
        assert!(!ip_is_public(v4("100.127.255.255")));
        assert!(ip_is_public(v4("100.63.255.255")));
        assert!(ip_is_public(v4("100.128.0.0")));
    }
}
