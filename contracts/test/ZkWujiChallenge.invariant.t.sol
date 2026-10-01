// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {AnyProof} from "./ZkWujiChallenge.t.sol";

/// Drives a ZkWujiIndex whose verifier accepts *anything* (a broken proof system), with an honest watcher
/// that disputes every forged batch when it appears, and griefers who dispute honest ones at random.
contract ZkChallengeHandler is Test {
    uint256 constant K = 8; // honest batches of 40 headers precomputed from the anchor
    uint256 constant BATCH = 40;

    ZkWujiIndex public idx;
    bytes headers;
    uint64 anchorHeight;
    uint32 maxTime;
    uint256 bond;

    ZkWujiIndex.Journal[K] honest;
    /// The real U at every real state hash the honest journals pass through (plus the anchor).
    mapping(bytes32 => bool) public isReal;
    mapping(bytes32 => int64) public realU;

    address[3] public actors = [address(0x1001), address(0x1002), address(0x1003)];
    uint256 public forgedProposed;
    uint256 public backs;
    uint256 public rejects;
    uint256 public finalized;

    constructor(ZkWujiIndex idx_, ZkWujiIndex shadow, bytes memory headers_, uint64 anchorHeight_) {
        idx = idx_;
        headers = headers_;
        anchorHeight = anchorHeight_;
        maxTime = uint32(block.timestamp);
        bond = idx.DISPUTE_BOND();
        for (uint256 i; i < 3; i++) vm.deal(actors[i], 1000 ether);

        (ZkWujiIndex.Continuity memory c, uint32[11] memory t, uint256 w) = shadow.continuity();
        isReal[c.hash] = true;
        realU[c.hash] = c.u;
        for (uint256 k = 0; k < K; k++) {
            ZkWujiIndex.Journal storage j = honest[k];
            j.prevHash = c.hash; j.prevHeight = c.height; j.prevBits = c.bits; j.prevTime = c.time;
            j.prevEpochStart = c.epochStart; j.prevTimes = t; j.prevU = c.u; j.prevWork = w;
            j.maxTime = maxTime; j.genesisHeight = idx.GENESIS_HEIGHT();
            j.checkpointInterval = idx.CHECKPOINT_INTERVAL(); j.confirmations = 6;
            shadow.foldHeaders(_headers(c.height, BATCH), new address[](0));
            (c, t, w) = shadow.continuity();
            j.newHash = c.hash; j.newHeight = c.height; j.newBits = c.bits; j.newTime = c.time;
            j.newEpochStart = c.epochStart; j.newTimes = t; j.newU = c.u; j.newWork = w;
            isReal[c.hash] = true;
            realU[c.hash] = c.u;
        }
    }

    function _headers(uint64 fromHeight, uint256 count) internal view returns (bytes memory out) {
        uint256 start = fromHeight - anchorHeight;
        out = new bytes(count * 80);
        for (uint256 i = 0; i < count * 80; i++) out[i] = headers[start * 80 + i];
    }

    function _real(ZkWujiIndex.Continuity memory c) internal view returns (bool) {
        return isReal[c.hash] && realU[c.hash] == c.u;
    }

    function _from(uint256 id) internal view returns (ZkWujiIndex.Continuity memory c) {
        if (id == idx.firstPending()) {
            (bytes32 h, uint64 height, uint32 bits, uint32 time, uint32 es, int64 u) = idx.tip();
            return ZkWujiIndex.Continuity(h, height, bits, time, es, u);
        }
        return idx.batch(id - 1).to;
    }

    function _full() internal view returns (bool) {
        return idx.pendingCount() >= idx.MAX_PENDING();
    }

    // ---------------------------------------------------------------- actions

    function proposeHonest(uint256 actorSeed) external {
        if (_full()) return;
        (ZkWujiIndex.Continuity memory head,,) = idx.continuity();
        for (uint256 k = 0; k < K; k++) {
            if (honest[k].prevHash == head.hash && honest[k].prevU == head.u) {
                vm.prank(actors[actorSeed % 3]);
                idx.foldProof(hex"c0ffee", abi.encode(honest[k]), new address[](0));
                return;
            }
        }
    }

    /// A forged batch on the current head; the honest watcher disputes it at once.
    function proposeForged(uint256 seed, bool realHashWrongU) external {
        if (_full()) return;
        (ZkWujiIndex.Continuity memory head, uint32[11] memory t, uint256 w) = idx.continuity();
        ZkWujiIndex.Journal memory j;
        bool built;
        if (realHashWrongU) {
            for (uint256 k = 0; k < K; k++) {
                if (honest[k].prevHash == head.hash && honest[k].prevU == head.u) {
                    j = abi.decode(abi.encode(honest[k]), (ZkWujiIndex.Journal));
                    j.newU += int64(int256(bound(seed, 1, 1e9)));
                    built = true;
                }
            }
        }
        if (!built) {
            j.prevHash = head.hash; j.prevHeight = head.height; j.prevBits = head.bits; j.prevTime = head.time;
            j.prevEpochStart = head.epochStart; j.prevTimes = t; j.prevU = head.u; j.prevWork = w;
            j.maxTime = maxTime; j.genesisHeight = idx.GENESIS_HEIGHT();
            j.checkpointInterval = idx.CHECKPOINT_INTERVAL(); j.confirmations = 6;
            j.newHash = keccak256(abi.encode(seed, head.hash));
            j.newHeight = head.height + uint64(bound(seed, 1, 200));
            j.newBits = head.bits; j.newTime = head.time; j.newEpochStart = head.epochStart; j.newTimes = t;
            j.newU = head.u + int64(int256(bound(seed >> 64, 0, 1e9))) - 5e8;
            j.newWork = w + seed % 1e30;
        }
        uint256 id = idx.foldProof(hex"bad0", abi.encode(j), new address[](0));
        ++forgedProposed;
        vm.prank(actors[0]);
        idx.dispute{value: bond}(id, new address[](0));
    }

    /// Griefing: dispute any open, undisputed batch.
    function grief(uint256 idSeed, uint256 actorSeed) external {
        uint256 n = idx.pendingCount();
        if (n == 0) return;
        uint256 id = idx.firstPending() + idSeed % n;
        ZkWujiIndex.Batch memory b = idx.batch(id);
        if (b.disputer != address(0) || block.timestamp >= b.finalAt) return;
        vm.prank(actors[actorSeed % 3]);
        idx.dispute{value: bond}(id, new address[](0));
    }

    /// Back a disputed batch with real headers. Honest batches must always succeed; forged ones never.
    function back(uint256 idSeed, uint256 actorSeed) external {
        uint256 n = idx.pendingCount();
        if (n == 0) return;
        uint256 id = idx.firstPending() + idSeed % n;
        ZkWujiIndex.Batch memory b = idx.batch(id);
        if (b.disputer == address(0) || b.backed || block.timestamp > b.respondBy) return;
        ZkWujiIndex.Continuity memory from = _from(id);
        if (!_real(from)) return; // nothing real to replay from; it will be rejected
        uint256 count = uint256(b.to.height - from.height) + 6;
        if (from.height - anchorHeight + count > headers.length / 80) return;
        bytes memory raw = _headers(from.height, count);
        vm.prank(actors[actorSeed % 3]);
        if (_real(b.to)) {
            idx.back(id, raw); // an honest batch can always be backed
            ++backs;
        } else {
            try idx.back(id, raw) {
                revert("a forged batch was backed");
            } catch {}
        }
    }

    function reject(uint256 idSeed) external {
        uint256 n = idx.pendingCount();
        if (n == 0) return;
        uint256 id = idx.firstPending() + idSeed % n;
        ZkWujiIndex.Batch memory b = idx.batch(id);
        if (b.disputer == address(0) || b.backed || block.timestamp <= b.respondBy) return;
        idx.reject(id);
        ++rejects;
    }

    function finalize(uint256 max) external {
        finalized += idx.finalize(bound(max, 1, 5));
    }

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 0, 8 hours));
    }

    function withdraw(uint256 actorSeed) external {
        vm.prank(actors[actorSeed % 3]);
        idx.withdraw();
    }

    // ---------------------------------------------------------------- ghost views

    function heldBonds() external view returns (uint256 held) {
        for (uint256 id = idx.firstPending(); id < idx.nextBatch(); id++) {
            ZkWujiIndex.Batch memory b = idx.batch(id);
            if (b.disputer != address(0) && !b.backed) held += bond;
        }
    }

    function owedTotal() external view returns (uint256 total) {
        for (uint256 i; i < 3; i++) total += idx.owed(actors[i]);
    }
}

/// Default depth (60) rarely gets a batch through dispute + response windows; 300 reaches all K honest batches.
/// forge-config: default.invariant.depth = 300
/// forge-config: default.invariant.runs = 32
contract ZkWujiChallengeInvariantTest is Test {
    ZkChallengeHandler handler;
    ZkWujiIndex idx;

    function setUp() public {
        string memory meta = vm.readFile("test/fixtures/bitcoin-timestamps.json");
        bytes memory headers = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps.hex"));
        bytes memory anchor = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        bytes memory ancestors = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        uint32[11] memory times;
        for (uint256 i = 0; i < 11; i++) {
            uint256 at = i * 80 + 68;
            times[i] = uint32(uint8(ancestors[at])) | uint32(uint8(ancestors[at + 1])) << 8
                | uint32(uint8(ancestors[at + 2])) << 16 | uint32(uint8(ancestors[at + 3])) << 24;
        }
        uint64 anchorHeight = uint64(vm.parseJsonUint(meta, ".checkpointHeight"));
        uint64 genesis = uint64(vm.parseJsonUint(meta, ".start"));
        uint32 epochStart = uint32(vm.parseJsonUint(meta, ".epochStartTime"));
        vm.warp(1_800_000_000);
        ZkWujiIndex.Challenge memory c = ZkWujiIndex.Challenge({window: 6 hours, responseWindow: 6 hours, bond: 0.05 ether});
        idx = new ZkWujiIndex(
            new AnyProof(), bytes32(uint256(1)), RelayerRewards(address(0)), anchor, anchorHeight, epochStart, times,
            0, genesis, 4320, c
        );
        ZkWujiIndex shadow = new ZkWujiIndex(
            ISP1Verifier(address(0)), bytes32(0), RelayerRewards(address(0)), anchor, anchorHeight, epochStart, times,
            0, genesis, 4320, c
        );
        handler = new ZkChallengeHandler(idx, shadow, headers, anchorHeight);
        targetContract(address(handler));
    }

    /// With an online watcher, nothing but real Bitcoin state is ever finalized, whatever the verifier says.
    function invariant_finalizedStateIsAlwaysReal() public view {
        (bytes32 h,,,,, int64 u) = idx.tip();
        assertTrue(handler.isReal(h), "finalized hash is not a real header");
        assertEq(handler.realU(h), u, "finalized U is not the real accumulator");
    }

    /// Every wei held is either owed to someone or a bond on an open dispute.
    function invariant_bondsAreConserved() public view {
        assertEq(address(idx).balance, handler.owedTotal() + handler.heldBonds());
    }

    function invariant_queueIsBounded() public view {
        assertLe(idx.pendingCount(), idx.MAX_PENDING());
    }

    function afterInvariant() external {
        emit log_named_uint("forged proposed", handler.forgedProposed());
        emit log_named_uint("honest backs", handler.backs());
        emit log_named_uint("rejects", handler.rejects());
        emit log_named_uint("batches finalized", handler.finalized());
    }
}
