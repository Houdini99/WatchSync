//! Per-IP rate limiting for the plain HTTP routes. The WebSocket path has its
//! own per-connection token buckets; the HTTP routes (room creation, and the
//! resolver-backed resolve/subtitles endpoints that each kick off a heavy yt-dlp
//! extraction) had none, so an unauthenticated loop could exhaust the resolver
//! for everyone. This is a small in-memory keyed limiter, sized so a legitimate
//! (even NAT-shared) client is never affected while trivial floods are refused.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::rate_limit::TokenBucket;

/// Drop buckets untouched for this long once the map hits capacity, so idle IPs
/// don't accumulate forever.
const IDLE_TTL: Duration = Duration::from_secs(600);
/// Hard cap on tracked IPs; a sweep of idle entries runs before this is exceeded.
const MAX_ENTRIES: usize = 100_000;

pub struct IpRateLimiter {
    inner: Mutex<HashMap<String, (TokenBucket, Instant)>>,
    capacity: f64,
    refill_per_sec: f64,
}

impl IpRateLimiter {
    pub fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            capacity: capacity.max(1.0),
            refill_per_sec: refill_per_sec.max(0.0),
        }
    }

    /// Spend one token for `key` (a client IP). `true` when the action is allowed.
    pub async fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut map = self.inner.lock().await;
        if map.len() >= MAX_ENTRIES {
            map.retain(|_, (_, last)| now.duration_since(*last) < IDLE_TTL);
        }
        let entry = map
            .entry(key.to_string())
            .or_insert_with(|| (TokenBucket::new(self.capacity, self.refill_per_sec), now));
        entry.1 = now;
        entry.0.take(1.0)
    }
}
