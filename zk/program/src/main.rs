//! SP1 guest: validate a batch of Bitcoin headers and commit the WUJI index it produces.
//!
//! Every rule lives in `wuji-header-core`, which is also unit-tested against real mainnet headers on
//! the host. The guest only marshals input and output, so there is one implementation of the rules,
//! not two.
#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::{sol, SolValue};
use wuji_header_core::{verify_batch, ChainState, U256};

sol! {
    /// Mirrors `ZkWujiIndex.Journal`. Field order and types must match exactly.
    struct Journal {
        bytes32 prevHash;
        uint64 prevHeight;
        uint32 prevBits;
        uint32 prevTime;
        uint32 prevEpochStart;
        uint32[11] prevTimes;
        int64 prevU;
        uint256 prevWork;
        uint32 maxTime;
        uint64 genesisHeight;
        uint64 checkpointInterval;
        uint64 confirmations;
        bytes32 newHash;
        uint64 newHeight;
        uint32 newBits;
        uint32 newTime;
        uint32 newEpochStart;
        uint32[11] newTimes;
        int64 newU;
        uint256 newWork;
        uint64[] checkpointHeights;
        int64[] checkpointU;
    }
}

const MAX_CHECKPOINTS: usize = 8;

pub fn main() {
    // Private inputs: the starting state and the headers. Everything that matters is re-derived and
    // committed, so a dishonest prover can only produce a journal the contract will reject.
    let prev_hash: [u8; 32] = sp1_zkvm::io::read();
    let prev_height: u64 = sp1_zkvm::io::read();
    let prev_bits: u32 = sp1_zkvm::io::read();
    let prev_time: u32 = sp1_zkvm::io::read();
    let prev_epoch_start: u32 = sp1_zkvm::io::read();
    let prev_times: [u32; 11] = sp1_zkvm::io::read();
    let prev_u: i64 = sp1_zkvm::io::read();
    let prev_work_be: [u8; 32] = sp1_zkvm::io::read();
    let max_time: u32 = sp1_zkvm::io::read();
    let genesis_height: u64 = sp1_zkvm::io::read();
    let checkpoint_interval: u64 = sp1_zkvm::io::read();
    let confirmations: u64 = sp1_zkvm::io::read();
    let headers: Vec<u8> = sp1_zkvm::io::read_vec();

    let start = ChainState {
        hash: prev_hash,
        height: prev_height,
        work: U256::from_be_bytes(&prev_work_be),
        bits: prev_bits,
        time: prev_time,
        epoch_start: prev_epoch_start,
        recent_times: prev_times,
        u: prev_u,
    };

    let out = verify_batch::<MAX_CHECKPOINTS>(
        start,
        &headers,
        max_time,
        genesis_height,
        checkpoint_interval,
        confirmations,
    )
    .expect("header batch must satisfy every consensus rule");

    let mut heights = Vec::with_capacity(out.checkpoint_count);
    let mut us = Vec::with_capacity(out.checkpoint_count);
    for cp in &out.checkpoints[..out.checkpoint_count] {
        heights.push(cp.height);
        us.push(cp.u);
    }

    let journal = Journal {
        prevHash: prev_hash.into(),
        prevHeight: prev_height,
        prevBits: prev_bits,
        prevTime: prev_time,
        prevEpochStart: prev_epoch_start,
        prevTimes: prev_times,
        prevU: prev_u,
        prevWork: alloy_sol_types::private::U256::from_be_bytes(prev_work_be),
        maxTime: max_time,
        genesisHeight: genesis_height,
        checkpointInterval: checkpoint_interval,
        confirmations,
        newHash: out.folded.hash.into(),
        newHeight: out.folded.height,
        newBits: out.folded.bits,
        newTime: out.folded.time,
        newEpochStart: out.folded.epoch_start,
        newTimes: out.folded.recent_times,
        newU: out.folded.u,
        newWork: alloy_sol_types::private::U256::from_be_bytes(out.folded.work.to_be_bytes()),
        checkpointHeights: heights,
        checkpointU: us,
    };
    sp1_zkvm::io::commit_slice(&journal.abi_encode());
}
