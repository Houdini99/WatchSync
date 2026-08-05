//! A classic token bucket. One bucket per concern (chat, reactions, global
//! flood guard) lives on each connection, so limits are inherently per-client
//! and require no shared state.

use std::time::Instant;

pub struct TokenBucket {
    capacity: f64,
    tokens: f64,
    refill_per_sec: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            capacity,
            tokens: capacity,
            refill_per_sec,
            last: Instant::now(),
        }
    }

    /// Attempt to spend `cost` tokens. Refills lazily based on elapsed wall time.
    /// Returns `true` if the action is allowed.
    pub fn take(&mut self, cost: f64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        self.last = now;
        if self.tokens < cost {
            return false;
        }
        self.tokens -= cost;
        true
    }
}
