//! Emit the ABI-encoded journal for a fixture batch so Foundry can decode it.
//!
//! This is the interop check that matters: if Rust's `abi_encode` and Solidity's `abi.decode` disagree
//! about this struct, a real proof would be rejected on chain for reasons no unit test would show.
//! Deliberately free of any zkVM dependency so it runs without the SP1 toolchain.
//!
//!   cargo run --release --example journal -- 100 contracts/test/fixtures/zk-journal.hex

use alloy_sol_types::{sol, SolValue};
use wuji_header_core::{sha256d, verify_batch, ChainState, U256};

sol! {
    struct Journal {
        bytes32 prevHash; uint64 prevHeight; uint32 prevBits; uint32 prevTime; uint32 prevEpochStart;
        uint32[11] prevTimes; int64 prevU; uint256 prevWork; uint32 maxTime; uint64 genesisHeight;
        uint64 checkpointInterval; uint64 confirmations; bytes32 newHash; uint64 newHeight; uint32 newBits;
        uint32 newTime; uint32 newEpochStart; uint32[11] newTimes; int64 newU; uint256 newWork;
        uint64[] checkpointHeights; int64[] checkpointU;
    }
}

fn repo(path: &str) -> String {
    format!("{}/../../{}", env!("CARGO_MANIFEST_DIR"), path)
}
fn hex_file(path: &str) -> Vec<u8> {
    let text = std::fs::read_to_string(repo(path)).unwrap();
    let t = text.trim().trim_start_matches("0x");
    (0..t.len() / 2).map(|i| u8::from_str_radix(&t[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let count: usize = args.get(1).map(|s| s.parse().unwrap()).unwrap_or(100);
    let out = args.get(2).cloned().unwrap_or_else(|| "contracts/test/fixtures/zk-journal.hex".into());
    let interval: u64 = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(4320);

    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(repo("contracts/test/fixtures/bitcoin-timestamps.json")).unwrap())
            .unwrap();
    let all = hex_file("contracts/test/fixtures/bitcoin-timestamps.hex");
    let ancestors = hex_file("contracts/test/fixtures/bitcoin-timestamps-ancestors.hex");
    let cp_hex = meta["checkpointHeader"].as_str().unwrap();
    let cp: Vec<u8> =
        (0..cp_hex.len() / 2).map(|i| u8::from_str_radix(&cp_hex[i * 2..i * 2 + 2], 16).unwrap()).collect();
    let mut recent_times = [0u32; 11];
    for (i, slot) in recent_times.iter_mut().enumerate() {
        let raw = &ancestors[i * 80..(i + 1) * 80];
        *slot = u32::from_le_bytes([raw[68], raw[69], raw[70], raw[71]]);
    }
    let start = ChainState {
        hash: sha256d(&cp),
        height: meta["checkpointHeight"].as_u64().unwrap(),
        work: U256::ZERO,
        bits: u32::from_le_bytes([cp[72], cp[73], cp[74], cp[75]]),
        time: u32::from_le_bytes([cp[68], cp[69], cp[70], cp[71]]),
        epoch_start: meta["epochStartTime"].as_u64().unwrap() as u32,
        recent_times,
        u: 0,
    };
    let genesis = meta["start"].as_u64().unwrap();
    let batch = verify_batch::<8>(start, &all[..count * 80], u32::MAX, genesis, interval, 6).unwrap();

    let journal = Journal {
        prevHash: start.hash.into(),
        prevHeight: start.height,
        prevBits: start.bits,
        prevTime: start.time,
        prevEpochStart: start.epoch_start,
        prevTimes: start.recent_times,
        prevU: start.u,
        prevWork: alloy_sol_types::private::U256::from_be_bytes(start.work.to_be_bytes()),
        maxTime: u32::MAX,
        genesisHeight: genesis,
        checkpointInterval: interval,
        confirmations: 6,
        newHash: batch.folded.hash.into(),
        newHeight: batch.folded.height,
        newBits: batch.folded.bits,
        newTime: batch.folded.time,
        newEpochStart: batch.folded.epoch_start,
        newTimes: batch.folded.recent_times,
        newU: batch.folded.u,
        newWork: alloy_sol_types::private::U256::from_be_bytes(batch.folded.work.to_be_bytes()),
        checkpointHeights: batch.checkpoints[..batch.checkpoint_count].iter().map(|c| c.height).collect(),
        checkpointU: batch.checkpoints[..batch.checkpoint_count].iter().map(|c| c.u).collect(),
    };
    let encoded = journal.abi_encode();
    let hex: String = encoded.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(repo(&out), format!("0x{hex}")).unwrap();
    println!("{} headers -> {} ({} bytes)", count, out, encoded.len());
    println!("newHeight={} newU={} checkpoints={}", journal.newHeight, journal.newU, journal.checkpointHeights.len());
}
