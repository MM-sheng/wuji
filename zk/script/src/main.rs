//! Host for the WUJI zk header program.
//!
//!   cargo run --release -- execute            # run the guest, print the journal, no proof
//!   cargo run --release -- prove              # generate a proof and report timing
//!   cargo run --release -- journal --out FILE # write the ABI-encoded journal for the Solidity test
//!
//! Inputs default to the committed mainnet fixtures so the numbers are comparable with the
//! Solidity and JS tests.
use alloy_sol_types::{sol, SolValue};
use clap::{Parser, Subcommand};
use sp1_sdk::blocking::{Elf, ProveRequest, Prover, ProverClient};
use sp1_sdk::{include_elf, HashableKey, ProvingKey, SP1Stdin};
use std::time::Instant;
use wuji_header_core::{sha256d, verify_batch, ChainState, U256};

pub const ELF: Elf = include_elf!("wuji-zk-program");

sol! {
    struct Journal {
        bytes32 prevHash; uint64 prevHeight; uint32 prevBits; uint32 prevTime; uint32 prevEpochStart;
        uint32[11] prevTimes; int64 prevU; uint256 prevWork; uint32 maxTime; uint64 genesisHeight;
        uint64 checkpointInterval; uint64 confirmations; bytes32 newHash; uint64 newHeight; uint32 newBits;
        uint32 newTime; uint32 newEpochStart; uint32[11] newTimes; int64 newU; uint256 newWork;
        uint64[] checkpointHeights; int64[] checkpointU;
    }
}

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
    /// How many fixture headers to feed the guest.
    #[arg(long, default_value_t = 100, global = true)]
    headers: usize,
}

#[derive(Subcommand)]
enum Command {
    Execute,
    Prove,
    Journal {
        #[arg(long)]
        out: String,
    },
}

struct Inputs {
    start: ChainState,
    headers: Vec<u8>,
    max_time: u32,
    genesis_height: u64,
    checkpoint_interval: u64,
    confirmations: u64,
}

fn repo(path: &str) -> String {
    format!("{}/../../{}", env!("CARGO_MANIFEST_DIR"), path)
}
fn hex_file(path: &str) -> Vec<u8> {
    let text = std::fs::read_to_string(repo(path)).unwrap();
    let t = text.trim().trim_start_matches("0x");
    (0..t.len() / 2).map(|i| u8::from_str_radix(&t[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

fn fixture_inputs(count: usize) -> Inputs {
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
    Inputs {
        start: ChainState {
            hash: sha256d(&cp),
            height: meta["checkpointHeight"].as_u64().unwrap(),
            work: U256::ZERO,
            bits: u32::from_le_bytes([cp[72], cp[73], cp[74], cp[75]]),
            time: u32::from_le_bytes([cp[68], cp[69], cp[70], cp[71]]),
            epoch_start: meta["epochStartTime"].as_u64().unwrap() as u32,
            recent_times,
            u: 0,
        },
        headers: all[..count * 80].to_vec(),
        max_time: u32::MAX,
        genesis_height: meta["start"].as_u64().unwrap(),
        checkpoint_interval: 4320,
        confirmations: 6,
    }
}

fn stdin_for(i: &Inputs) -> SP1Stdin {
    let mut stdin = SP1Stdin::new();
    stdin.write(&i.start.hash);
    stdin.write(&i.start.height);
    stdin.write(&i.start.bits);
    stdin.write(&i.start.time);
    stdin.write(&i.start.epoch_start);
    stdin.write(&i.start.recent_times);
    stdin.write(&i.start.u);
    stdin.write(&i.start.work.to_be_bytes());
    stdin.write(&i.max_time);
    stdin.write(&i.genesis_height);
    stdin.write(&i.checkpoint_interval);
    stdin.write(&i.confirmations);
    stdin.write_vec(i.headers.clone());
    stdin
}

/// The journal the guest must produce, computed on the host from the same crate.
fn expected_journal(i: &Inputs) -> Journal {
    let out = verify_batch::<8>(
        i.start,
        &i.headers,
        i.max_time,
        i.genesis_height,
        i.checkpoint_interval,
        i.confirmations,
    )
    .expect("fixtures validate");
    Journal {
        prevHash: i.start.hash.into(),
        prevHeight: i.start.height,
        prevBits: i.start.bits,
        prevTime: i.start.time,
        prevEpochStart: i.start.epoch_start,
        prevTimes: i.start.recent_times,
        prevU: i.start.u,
        prevWork: alloy_sol_types::private::U256::from_be_bytes(i.start.work.to_be_bytes()),
        maxTime: i.max_time,
        genesisHeight: i.genesis_height,
        checkpointInterval: i.checkpoint_interval,
        confirmations: i.confirmations,
        newHash: out.folded.hash.into(),
        newHeight: out.folded.height,
        newBits: out.folded.bits,
        newTime: out.folded.time,
        newEpochStart: out.folded.epoch_start,
        newTimes: out.folded.recent_times,
        newU: out.folded.u,
        newWork: alloy_sol_types::private::U256::from_be_bytes(out.folded.work.to_be_bytes()),
        checkpointHeights: out.checkpoints[..out.checkpoint_count].iter().map(|c| c.height).collect(),
        checkpointU: out.checkpoints[..out.checkpoint_count].iter().map(|c| c.u).collect(),
    }
}

fn main() {
    let cli = Cli::parse();
    let inputs = fixture_inputs(cli.headers);
    let expected = expected_journal(&inputs);

    match cli.command {
        Command::Journal { out } => {
            std::fs::write(&out, format!("0x{}", hex(&expected.abi_encode()))).unwrap();
            println!("journal written to {out} ({} headers)", cli.headers);
            println!("newHeight={} newU={}", expected.newHeight, expected.newU);
        }
        Command::Execute => {
            let client = ProverClient::from_env();
            let started = Instant::now();
            let (public_values, report) = client.execute(ELF, stdin_for(&inputs)).run().unwrap();
            println!("headers      : {}", cli.headers);
            println!("cycles       : {}", report.total_instruction_count());
            println!("execute time : {:?}", started.elapsed());
            assert_eq!(public_values.as_slice(), expected.abi_encode(), "guest journal must equal the host's");
            println!("journal      : matches the host computation exactly");
        }
        Command::Prove => {
            let client = ProverClient::from_env();
            let pk = client.setup(ELF).expect("setup");
            let vk = pk.verifying_key();
            let started = Instant::now();
            let proof = client.prove(&pk, stdin_for(&inputs)).groth16().run().expect("prove");
            println!("headers    : {}", cli.headers);
            println!("prove time : {:?}", started.elapsed());
            println!("vkey       : {}", vk.bytes32());
            println!("journal    : 0x{}", hex(proof.public_values.as_slice()));
            println!("proof      : 0x{}", hex(&proof.bytes()));
            client.verify(&proof, vk, None).expect("proof must verify");
            println!("verified   : yes");
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
