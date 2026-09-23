//! The rules must reproduce real mainnet headers exactly — same U, same work, same retargets — or
//! nothing built on top of them matters. Fixtures are the ones the Solidity and JS tests already use.

use serde_json::Value;
use std::fs;
use wuji_header_core::*;

fn repo(path: &str) -> String {
    format!("{}/../../{}", env!("CARGO_MANIFEST_DIR"), path)
}
fn hex_file(path: &str) -> Vec<u8> {
    let text = fs::read_to_string(repo(path)).unwrap();
    let trimmed = text.trim().trim_start_matches("0x");
    (0..trimmed.len() / 2)
        .map(|i| u8::from_str_radix(&trimmed[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}
fn json_file(path: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(repo(path)).unwrap()).unwrap()
}

/// Build the state at the fixture's anchor height from the checkpoint header and its 11 ancestors.
fn anchor(meta: &Value) -> ChainState {
    let cp: Vec<u8> = {
        let s = meta["checkpointHeader"].as_str().unwrap();
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect()
    };
    let ancestors = hex_file("contracts/test/fixtures/bitcoin-timestamps-ancestors.hex");
    assert_eq!(ancestors.len(), 11 * HEADER_LEN, "expected 11 ancestor headers");
    let mut recent_times = [0u32; 11];
    for (i, slot) in recent_times.iter_mut().enumerate() {
        let raw = &ancestors[i * HEADER_LEN..(i + 1) * HEADER_LEN];
        *slot = u32::from_le_bytes([raw[68], raw[69], raw[70], raw[71]]);
    }
    ChainState {
        hash: sha256d(&cp),
        height: meta["checkpointHeight"].as_u64().unwrap(),
        work: U256::ZERO,
        bits: u32::from_le_bytes([cp[72], cp[73], cp[74], cp[75]]),
        time: u32::from_le_bytes([cp[68], cp[69], cp[70], cp[71]]),
        epoch_start: meta["epochStartTime"].as_u64().unwrap() as u32,
        recent_times,
        u: 0,
    }
}

#[test]
fn reproduces_the_index_over_6060_real_headers_and_four_retargets() {
    let meta = json_file("contracts/test/fixtures/bitcoin-timestamps.json");
    let headers = hex_file("contracts/test/fixtures/bitcoin-timestamps.hex");
    let count = meta["count"].as_u64().unwrap();
    assert_eq!(headers.len() as u64, count * HEADER_LEN as u64);

    let start = anchor(&meta);
    let out: BatchOutput<8> = verify_batch(start, &headers, u32::MAX, meta["start"].as_u64().unwrap(), 4320, 6)
        .expect("real mainnet headers must validate");

    assert_eq!(out.end.height, meta["start"].as_u64().unwrap() + count - 1);
    assert_eq!(out.end.u, meta["U"].as_i64().unwrap(), "index accumulator U");
    assert_eq!(
        s_wad(out.end.u).to_string(),
        meta["S_wad"].as_str().unwrap(),
        "S in wad must equal what the contract stores"
    );
    assert_eq!(out.end.time, meta["lastTimestamp"].as_u64().unwrap() as u32);
    assert_eq!(out.folded_height, meta["start"].as_u64().unwrap() + count - 1 - 6);
    assert!(out.end.work > U256::ZERO);
}

#[test]
fn per_header_increment_matches_the_committed_vectors() {
    let meta = json_file("contracts/test/fixtures/bitcoin-timestamps.json");
    let headers = hex_file("contracts/test/fixtures/bitcoin-timestamps.hex");
    let vectors = hex_file("contracts/test/fixtures/bitcoin-timestamps-vectors.hex");
    let count = meta["count"].as_u64().unwrap() as usize;
    assert_eq!(vectors.len(), count * 32, "one R per header");

    let mut u = 0i64;
    for i in 0..count {
        let hash = sha256d(&headers[i * HEADER_LEN..(i + 1) * HEADER_LEN]);
        let mut r = [0u8; 32];
        r.copy_from_slice(&sha2_of(&hash));
        assert_eq!(&r[..], &vectors[i * 32..(i + 1) * 32], "R at index {i}");
        u += increment_of(&hash);
    }
    assert_eq!(u, meta["U"].as_i64().unwrap());
}

/// The known anchor from `bitcoin.json`: height 800000 pins the digest order for every implementation.
#[test]
fn height_800000_pins_the_digest_order() {
    let meta = json_file("contracts/test/fixtures/bitcoin.json");
    let known = &meta["known800000"];
    let headers = hex_file("contracts/test/fixtures/bitcoin-798336.hex");
    let offset = (800000 - 798336) * HEADER_LEN;
    let hash = sha256d(&headers[offset..offset + HEADER_LEN]);

    let display: String = hash.iter().rev().map(|b| format!("{b:02x}")).collect();
    assert_eq!(display, known["hash"].as_str().unwrap(), "explorer hash");
    let internal: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(internal, known["internalHash"].as_str().unwrap(), "raw digest order");
    let r: String = sha2_of(&hash).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(r, known["R"].as_str().unwrap(), "R = sha256(raw digest)");
    assert_eq!(increment_of(&hash), known["delta"].as_i64().unwrap());
    assert_eq!(s_wad(increment_of(&hash)).to_string(), known["S_wad"].as_str().unwrap());
}

#[test]
fn compact_targets_round_trip_and_reject_what_the_relay_rejects() {
    for bits in [0x1d00ffffu32, 0x17053894, 0x1702ffff, 0x170355f0] {
        assert_eq!(compact(target_of(bits).unwrap()), bits, "round trip {bits:08x}");
    }
    assert_eq!(target_of(0x1d80ffff), Err(Error::TargetSignOrZero));
    assert_eq!(target_of(0x1d000000), Err(Error::TargetSignOrZero));
    assert_eq!(target_of(0x23000001), Err(Error::TargetOverflow));
    assert_eq!(target_of(0x1e00ffff), Err(Error::TargetRange));
}

#[test]
fn retarget_clamps_at_four_times_and_one_quarter() {
    let bits = 0x17053894u32;
    let quarter = target_of(bits).unwrap().mul_div_for_test(1, 4);
    assert_eq!(retarget(bits, 100, 99).unwrap(), compact(quarter), "fast epoch clamps to /4");
    let quadruple = target_of(bits).unwrap().mul_div_for_test(4, 1);
    assert_eq!(retarget(bits, 100, 10_000_000).unwrap(), compact(quadruple), "slow epoch clamps to x4");
    assert_eq!(retarget(0x1d00ffff, 0, 10_000_000).unwrap(), 0x1d00ffff, "never easier than the PoW limit");
}

#[test]
fn rejects_tampered_and_out_of_order_headers() {
    let meta = json_file("contracts/test/fixtures/bitcoin-timestamps.json");
    let headers = hex_file("contracts/test/fixtures/bitcoin-timestamps.hex");
    let start = anchor(&meta);
    let genesis = meta["start"].as_u64().unwrap();

    let run = |bytes: &[u8]| -> Result<BatchOutput<8>, Error> {
        verify_batch(start, bytes, u32::MAX, genesis, 4320, 6)
    };
    let short = &headers[..20 * HEADER_LEN];
    assert!(run(short).is_ok(), "a clean prefix must validate");

    let mut flipped = short.to_vec();
    flipped[76] ^= 1; // nonce of the first header
    assert_eq!(run(&flipped), Err(Error::Pow));

    let mut relinked = short.to_vec();
    relinked[10] ^= 1; // prevHash of the first header
    assert_eq!(run(&relinked), Err(Error::Linkage));

    let mut bits = short.to_vec();
    bits[72] ^= 1;
    assert_eq!(run(&bits), Err(Error::Difficulty));

    // Future-time bound is the caller's, not the prover's.
    assert_eq!(
        verify_batch::<8>(start, short, 1_000_000, genesis, 4320, 6),
        Err(Error::FutureTime)
    );
    // A batch with no confirmation margin cannot fold anything.
    assert_eq!(
        verify_batch::<8>(start, &headers[..6 * HEADER_LEN], u32::MAX, genesis, 4320, 6),
        Err(Error::NotEnoughConfirmations)
    );
}

#[test]
fn records_the_checkpoint_inside_a_batch() {
    let meta = json_file("contracts/test/fixtures/bitcoin-timestamps.json");
    let headers = hex_file("contracts/test/fixtures/bitcoin-timestamps.hex");
    let start = anchor(&meta);
    let genesis = meta["start"].as_u64().unwrap();
    // interval 100 → boundaries at genesis+99, +199, ... inside the fixture range
    let out: BatchOutput<64> = verify_batch(start, &headers[..1000 * HEADER_LEN], u32::MAX, genesis, 100, 6).unwrap();
    assert_eq!(out.checkpoint_count, 9, "boundaries at +99 … +899 are folded; +999 is inside the 6-block margin");
    assert_eq!(out.checkpoints[0].height, genesis + 99);
    for (i, cp) in out.checkpoints[..out.checkpoint_count].iter().enumerate() {
        assert_eq!(cp.height, genesis + 99 + 100 * i as u64);
    }
}
