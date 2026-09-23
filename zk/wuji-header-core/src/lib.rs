//! Bitcoin header-chain rules plus the WUJI index accumulator.
//!
//! This is the single source of truth for the zkVM guest. Every rule here must match
//! `contracts/src/BitcoinRelay.sol` and the path definition in `docs/tasks/BTC_SOURCE.md`;
//! `tests/fixtures.rs` proves it reproduces the exact `U` of real mainnet headers.
//!
//! No std-only APIs, no allocation in the hot loop, no zkVM dependency.

#![cfg_attr(not(test), no_std)]

use sha2::{Digest, Sha256};

pub const HEADER_LEN: usize = 80;
pub const RETARGET_INTERVAL: u64 = 2016;
pub const TARGET_TIMESPAN: u64 = 14 * 24 * 60 * 60;
pub const MEAN: i64 = 4080;
/// wad increment per unit of (byteSum − MEAN); `WujiIndex.UNIT`.
pub const UNIT_WAD: i128 = 12_000_000_000_000;
/// Highest permitted target (difficulty 1).
pub const POW_LIMIT: U256 = U256([
    0x0000_0000_ffff_ffff,
    0xffff_ffff_ffff_ffff,
    0xffff_ffff_ffff_ffff,
    0xffff_ffff_ffff_ffff,
]);

/// Big-endian 256-bit unsigned integer: limbs[0] is the most significant word.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default)]
pub struct U256(pub [u64; 4]);

impl U256 {
    pub const ZERO: U256 = U256([0; 4]);
    pub const ONE: U256 = U256([0, 0, 0, 1]);

    pub fn from_be_bytes(b: &[u8; 32]) -> U256 {
        let mut limbs = [0u64; 4];
        for (i, limb) in limbs.iter_mut().enumerate() {
            let mut v = 0u64;
            for j in 0..8 {
                v = (v << 8) | b[i * 8 + j] as u64;
            }
            *limb = v;
        }
        U256(limbs)
    }
    pub fn to_be_bytes(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, limb) in self.0.iter().enumerate() {
            out[i * 8..i * 8 + 8].copy_from_slice(&limb.to_be_bytes());
        }
        out
    }
    pub fn is_zero(self) -> bool {
        self.0 == [0; 4]
    }
    pub fn add(self, other: U256) -> U256 {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for i in (0..4).rev() {
            let sum = self.0[i] as u128 + other.0[i] as u128 + carry;
            out[i] = sum as u64;
            carry = sum >> 64;
        }
        U256(out)
    }
    fn shl8(self, bytes: u32) -> U256 {
        let mut b = self.to_be_bytes();
        let n = bytes as usize;
        if n >= 32 {
            return U256::ZERO;
        }
        let mut out = [0u8; 32];
        out[..32 - n].copy_from_slice(&b[n..]);
        b = out;
        U256::from_be_bytes(&b)
    }
    fn shr8(self, bytes: u32) -> U256 {
        let b = self.to_be_bytes();
        let n = bytes as usize;
        if n >= 32 {
            return U256::ZERO;
        }
        let mut out = [0u8; 32];
        out[n..].copy_from_slice(&b[..32 - n]);
        U256::from_be_bytes(&out)
    }
    /// Multiply by a small factor and divide by another; used only for the retarget, where the
    /// intermediate cannot overflow because `target ≤ POW_LIMIT` and `factor ≤ 4·TARGET_TIMESPAN`.
    fn mul_div_u64(self, mul: u64, div: u64) -> U256 {
        // schoolbook: 256×64 → 320 bits held in five 64-bit words, then divide by a 64-bit divisor
        let mut wide = [0u64; 5];
        let mut carry = 0u128;
        for i in (0..4).rev() {
            let prod = self.0[i] as u128 * mul as u128 + carry;
            wide[i + 1] = prod as u64;
            carry = prod >> 64;
        }
        wide[0] = carry as u64;
        let mut rem = 0u128;
        let mut quot = [0u64; 5];
        for i in 0..5 {
            let cur = (rem << 64) | wide[i] as u128;
            quot[i] = (cur / div as u128) as u64;
            rem = cur % div as u128;
        }
        // quot[0] is zero whenever the result fits in 256 bits, which the caller guarantees
        U256([quot[1], quot[2], quot[3], quot[4]])
    }
    /// Test helper: scale a target by `mul/div` using the same path the retarget uses.
    pub fn mul_div_for_test(self, mul: u64, div: u64) -> U256 {
        self.mul_div_u64(mul, div)
    }
    /// `floor(2^256 / (self + 1))`, Bitcoin's per-block work. `self` is a valid target, never zero.
    fn work(self) -> U256 {
        // 2^256 / (t+1) == ((2^256 - t - 1) / (t + 1)) + 1, computed without a 257-bit intermediate
        let denom = self.add(U256::ONE);
        let numer = U256([!self.0[0], !self.0[1], !self.0[2], !self.0[3]]); // 2^256 − 1 − self
        numer.div(denom).add(U256::ONE)
    }
    /// Long division by another U256. Only used off the hot path (work accumulation), so the simple
    /// bitwise algorithm is fine and keeps the guest small.
    fn div(self, other: U256) -> U256 {
        if other.is_zero() {
            return U256::ZERO;
        }
        let mut quot = U256::ZERO;
        let mut rem = U256::ZERO;
        for bit in 0..256 {
            rem = rem.shl1();
            if self.bit(255 - bit) {
                rem.0[3] |= 1;
            }
            if rem >= other {
                rem = rem.sub(other);
                quot = quot.set_bit(255 - bit);
            }
        }
        quot
    }
    fn shl1(self) -> U256 {
        let mut out = [0u64; 4];
        let mut carry = 0u64;
        for i in (0..4).rev() {
            out[i] = (self.0[i] << 1) | carry;
            carry = self.0[i] >> 63;
        }
        U256(out)
    }
    fn bit(self, index: usize) -> bool {
        (self.0[3 - index / 64] >> (index % 64)) & 1 == 1
    }
    fn set_bit(mut self, index: usize) -> U256 {
        self.0[3 - index / 64] |= 1 << (index % 64);
        self
    }
    fn sub(self, other: U256) -> U256 {
        let mut out = [0u64; 4];
        let mut borrow = 0i128;
        for i in (0..4).rev() {
            let diff = self.0[i] as i128 - other.0[i] as i128 - borrow;
            if diff < 0 {
                out[i] = (diff + (1i128 << 64)) as u64;
                borrow = 1;
            } else {
                out[i] = diff as u64;
                borrow = 0;
            }
        }
        U256(out)
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Error {
    HeaderLength,
    TargetSignOrZero,
    TargetOverflow,
    TargetRange,
    Pow,
    Linkage,
    Difficulty,
    MedianTimePast,
    FutureTime,
    NotEnoughConfirmations,
    BatchEmpty,
}

/// Decode Bitcoin's compact `nBits` into a target, rejecting exactly what the relay rejects.
pub fn target_of(bits: u32) -> Result<U256, Error> {
    let size = bits >> 24;
    let word = bits & 0x007f_ffff;
    if word == 0 || bits & 0x0080_0000 != 0 {
        return Err(Error::TargetSignOrZero);
    }
    if size > 34
        || (word > 0xff && size > 33)
        || (word > 0xffff && size > 32)
    {
        return Err(Error::TargetOverflow);
    }
    let base = U256([0, 0, 0, word as u64]);
    let target = if size <= 3 {
        base.shr8(3 - size)
    } else {
        base.shl8(size - 3)
    };
    if target.is_zero() || target > POW_LIMIT {
        return Err(Error::TargetRange);
    }
    Ok(target)
}

/// Encode a target back into compact form, matching `BitcoinRelay.compact`.
pub fn compact(target: U256) -> u32 {
    let bytes = target.to_be_bytes();
    let leading = bytes.iter().take_while(|b| **b == 0).count();
    let mut size = (32 - leading) as u32;
    let mut word = if size <= 3 {
        let mut v = 0u64;
        for i in 0..size as usize {
            v = (v << 8) | bytes[32 - size as usize + i] as u64;
        }
        v << (8 * (3 - size))
    } else {
        let start = leading;
        ((bytes[start] as u64) << 16) | ((bytes[start + 1] as u64) << 8) | bytes[start + 2] as u64
    };
    if word & 0x0080_0000 != 0 {
        word >>= 8;
        size += 1;
    }
    (word as u32) | (size << 24)
}

/// The next epoch's `nBits`, with Bitcoin's ×4 / ÷4 clamp.
pub fn retarget(bits: u32, epoch_start: u32, last_time: u32) -> Result<u32, Error> {
    let mut elapsed = last_time as i64 - epoch_start as i64;
    let min = (TARGET_TIMESPAN / 4) as i64;
    let max = (TARGET_TIMESPAN * 4) as i64;
    if elapsed < min {
        elapsed = min;
    }
    if elapsed > max {
        elapsed = max;
    }
    let next = target_of(bits)?.mul_div_u64(elapsed as u64, TARGET_TIMESPAN);
    Ok(compact(if next > POW_LIMIT { POW_LIMIT } else { next }))
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}
pub fn sha256d(data: &[u8]) -> [u8; 32] {
    sha256(&sha256(data))
}

/// A single SHA-256, exposed so tests can recompute `R` directly.
pub fn sha2_of(data: &[u8]) -> [u8; 32] {
    sha256(data)
}

/// The WUJI per-header increment: `byteSum(sha256(sha256d(header))) − 4080`.
/// The inner digest is used in raw order, never the reversed display string.
pub fn increment_of(header_hash: &[u8; 32]) -> i64 {
    let r = sha256(header_hash);
    r.iter().map(|b| *b as i64).sum::<i64>() - MEAN
}

/// Everything the next header needs to be checked against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainState {
    pub hash: [u8; 32],
    pub height: u64,
    pub work: U256,
    pub bits: u32,
    pub time: u32,
    /// Timestamp of the first header of the current 2016-block epoch.
    pub epoch_start: u32,
    /// Timestamps of the last 11 headers, oldest first; used for median-time-past.
    pub recent_times: [u32; 11],
    /// The index accumulator `U` at `height`.
    pub u: i64,
}

impl ChainState {
    fn median_time_past(&self) -> u32 {
        let mut times = self.recent_times;
        times.sort_unstable();
        times[5]
    }
    fn push_time(&mut self, time: u32) {
        for i in 0..10 {
            self.recent_times[i] = self.recent_times[i + 1];
        }
        self.recent_times[10] = time;
    }
}

/// A boundary height whose `U` the index must record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub height: u64,
    pub u: i64,
}

/// What a proof commits to.
///
/// `folded` is the state at `end.height − confirmations`, **not** at the validated tip. Continuity is
/// carried forward from there so a reorg shallower than `confirmations` can never orphan the committed
/// state — which is exactly what the confirmation rule is for. The last `confirmations` headers are
/// validated only to demonstrate that the folded tip has that many descendants.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchOutput<const MAX_CHECKPOINTS: usize> {
    /// State at the validated tip; useful for diagnostics, never used for continuity.
    pub end: ChainState,
    /// State carried forward: the batch's tip minus `confirmations`.
    pub folded: ChainState,
    pub checkpoints: [Checkpoint; MAX_CHECKPOINTS],
    pub checkpoint_count: usize,
}

/// Validate `headers` on top of `start` and accumulate the index.
///
/// `max_time` is the future-time bound the *caller* supplies (the contract's `block.timestamp + 2h`),
/// so the prover never gets to decide what "now" is.
pub fn verify_batch<const MAX_CHECKPOINTS: usize>(
    start: ChainState,
    headers: &[u8],
    max_time: u32,
    genesis_height: u64,
    checkpoint_interval: u64,
    confirmations: u64,
) -> Result<BatchOutput<MAX_CHECKPOINTS>, Error> {
    if headers.is_empty() || headers.len() % HEADER_LEN != 0 {
        return Err(Error::HeaderLength);
    }
    let count = (headers.len() / HEADER_LEN) as u64;
    if count <= confirmations {
        return Err(Error::NotEnoughConfirmations);
    }

    let mut state = start;
    let mut checkpoints = [Checkpoint { height: 0, u: 0 }; MAX_CHECKPOINTS];
    let mut checkpoint_count = 0usize;
    let folded_target = start.height + count - confirmations;
    let mut folded = start;

    for i in 0..count as usize {
        let raw = &headers[i * HEADER_LEN..(i + 1) * HEADER_LEN];
        let height = state.height + 1;
        let bits = u32::from_le_bytes([raw[72], raw[73], raw[74], raw[75]]);
        let time = u32::from_le_bytes([raw[68], raw[69], raw[70], raw[71]]);

        if raw[4..36] != state.hash {
            return Err(Error::Linkage);
        }
        let expected = if height % RETARGET_INTERVAL == 0 {
            retarget(state.bits, state.epoch_start, state.time)?
        } else {
            state.bits
        };
        if bits != expected {
            return Err(Error::Difficulty);
        }
        if time <= state.median_time_past() {
            return Err(Error::MedianTimePast);
        }
        if time > max_time {
            return Err(Error::FutureTime);
        }
        let target = target_of(bits)?;
        let hash = sha256d(raw);
        // PoW compares the digest read little-endian, i.e. the reversed bytes as a big-endian number.
        let mut reversed = [0u8; 32];
        for (j, b) in hash.iter().enumerate() {
            reversed[31 - j] = *b;
        }
        if U256::from_be_bytes(&reversed) > target {
            return Err(Error::Pow);
        }

        state.u += increment_of(&hash);
        state.hash = hash;
        state.height = height;
        state.bits = bits;
        state.time = time;
        state.work = state.work.add(target.work());
        state.push_time(time);
        if height % RETARGET_INTERVAL == 0 {
            state.epoch_start = time;
        }

        if height <= folded_target {
            folded = state;
            if height >= genesis_height
                && (height + 1 - genesis_height) % checkpoint_interval == 0
                && checkpoint_count < MAX_CHECKPOINTS
            {
                checkpoints[checkpoint_count] = Checkpoint { height, u: state.u };
                checkpoint_count += 1;
            }
        }
    }

    debug_assert_eq!(folded.height, folded_target);
    Ok(BatchOutput { end: state, folded, checkpoints, checkpoint_count })
}

/// `S` in wad, as the contract stores it.
pub fn s_wad(u: i64) -> i128 {
    u as i128 * UNIT_WAD
}
