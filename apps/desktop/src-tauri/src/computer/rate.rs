//! The action rate limit (S24.4): at most `max` tool calls in any sliding window.

use std::collections::VecDeque;

pub const MAX_ACTIONS_PER_SECOND: usize = 10;

pub struct RateLimiter {
    max: usize,
    window_ms: u64,
    accepted: VecDeque<u64>,
}

impl RateLimiter {
    pub fn new(max: usize, window_ms: u64) -> Self {
        RateLimiter { max, window_ms, accepted: VecDeque::new() }
    }

    fn slide(&mut self, now_ms: u64) {
        while self.accepted.front().is_some_and(|&t| t + self.window_ms <= now_ms) {
            self.accepted.pop_front();
        }
    }

    /// Milliseconds until a call at `now_ms` would be accepted; 0 when it would be now.
    pub fn wait_ms(&mut self, now_ms: u64) -> u64 {
        self.slide(now_ms);
        if self.accepted.len() < self.max {
            return 0;
        }
        self.accepted.front().map_or(0, |&t| t + self.window_ms - now_ms)
    }

    /// Counts a call at `now_ms` and returns true, or returns false (not counted) when
    /// `max` calls were already accepted within the last `window_ms`.
    pub fn try_acquire(&mut self, now_ms: u64) -> bool {
        self.slide(now_ms);
        if self.accepted.len() >= self.max {
            return false;
        }
        self.accepted.push_back(now_ms);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_calls_within_a_second_are_accepted_and_the_eleventh_is_not() {
        let mut limiter = RateLimiter::new(MAX_ACTIONS_PER_SECOND, 1000);
        for i in 0..10 {
            assert!(limiter.try_acquire(1_000 + i * 50), "call {i}");
        }
        assert!(!limiter.try_acquire(1_999));
    }

    #[test]
    fn calls_are_accepted_again_once_the_window_slides() {
        let mut limiter = RateLimiter::new(2, 1000);
        assert!(limiter.try_acquire(0));
        assert!(limiter.try_acquire(500));
        assert!(!limiter.try_acquire(999));
        assert!(limiter.try_acquire(1000));
        assert!(!limiter.try_acquire(1499));
        assert!(limiter.try_acquire(1500));
    }

    #[test]
    fn it_tells_how_long_until_the_next_call_fits() {
        let mut limiter = RateLimiter::new(2, 1000);
        assert_eq!(limiter.wait_ms(0), 0);
        assert!(limiter.try_acquire(0));
        assert!(limiter.try_acquire(300));
        assert_eq!(limiter.wait_ms(400), 600);
        assert_eq!(limiter.wait_ms(1000), 0);
    }

    #[test]
    fn rejected_calls_do_not_count() {
        let mut limiter = RateLimiter::new(1, 1000);
        assert!(limiter.try_acquire(0));
        for t in [100, 200, 900] {
            assert!(!limiter.try_acquire(t));
        }
        assert!(limiter.try_acquire(1000));
    }
}
