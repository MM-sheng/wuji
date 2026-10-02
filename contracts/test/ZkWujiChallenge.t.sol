// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

/// Accepts any proof: stands in for a *broken* proof system, the case the challenge window exists for.
contract AnyProof is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {}
}

/// Shared fixture: real mainnet headers, a shadow header-path index to build honest journals.
abstract contract ZkChallengeBase is Test {
    uint64 constant W = 6 hours;
    uint64 constant R = 6 hours;
    uint256 constant BOND = 0.05 ether;

    bytes headers;
    string meta;
    uint64 anchorHeight;
    uint64 genesis;
    ISP1Verifier anyProof;

    function _load() internal {
        meta = vm.readFile("test/fixtures/bitcoin-timestamps.json");
        headers = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps.hex"));
        anchorHeight = uint64(vm.parseJsonUint(meta, ".checkpointHeight"));
        genesis = uint64(vm.parseJsonUint(meta, ".start"));
        anyProof = new AnyProof();
        vm.warp(1_800_000_000);
    }

    function _deploy(ISP1Verifier verifier, RelayerRewards rewards, uint64 interval) internal returns (ZkWujiIndex) {
        bytes memory anchor = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        bytes memory ancestors = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        uint32[11] memory times;
        for (uint256 i = 0; i < 11; i++) {
            uint256 at = i * 80 + 68;
            times[i] = uint32(uint8(ancestors[at])) | uint32(uint8(ancestors[at + 1])) << 8
                | uint32(uint8(ancestors[at + 2])) << 16 | uint32(uint8(ancestors[at + 3])) << 24;
        }
        return new ZkWujiIndex(
            verifier, bytes32(uint256(1)), rewards, anchor, anchorHeight,
            uint32(vm.parseJsonUint(meta, ".epochStartTime")), times, 0, genesis, interval,
            ZkWujiIndex.Challenge({window: W, responseWindow: R, bond: BOND})
        );
    }

    /// `count` raw headers starting right after height `fromHeight`.
    function _headers(uint64 fromHeight, uint256 count) internal view returns (bytes memory out) {
        uint256 start = fromHeight - anchorHeight;
        out = new bytes(count * 80);
        for (uint256 i = 0; i < count * 80; i++) {
            out[i] = headers[start * 80 + i];
        }
    }

    /// The journal an honest guest emits for `count` headers on top of `target`'s current head.
    function _honest(ZkWujiIndex target, uint256 count) internal returns (ZkWujiIndex.Journal memory j) {
        (ZkWujiIndex.Continuity memory prev, uint32[11] memory prevTimes, uint256 prevWork) = target.continuity();
        ZkWujiIndex shadow = _deploy(ISP1Verifier(address(0)), RelayerRewards(address(0)), target.CHECKPOINT_INTERVAL());
        if (prev.height > anchorHeight) {
            shadow.foldHeaders(_headers(anchorHeight, prev.height - anchorHeight + 6), new address[](0));
        }
        require(shadow.lastHash() == prev.hash, "head is not on the real chain");
        uint256 cpBefore = _boundaries(target, prev.height);
        shadow.foldHeaders(_headers(prev.height, count), new address[](0));
        (ZkWujiIndex.Continuity memory next, uint32[11] memory nextTimes, uint256 nextWork) = shadow.continuity();

        j.prevHash = prev.hash; j.prevHeight = prev.height; j.prevBits = prev.bits; j.prevTime = prev.time;
        j.prevEpochStart = prev.epochStart; j.prevTimes = prevTimes; j.prevU = prev.u; j.prevWork = prevWork;
        j.maxTime = uint32(block.timestamp);
        j.genesisHeight = genesis;
        j.checkpointInterval = target.CHECKPOINT_INTERVAL();
        j.confirmations = 6;
        j.newHash = next.hash; j.newHeight = next.height; j.newBits = next.bits; j.newTime = next.time;
        j.newEpochStart = next.epochStart; j.newTimes = nextTimes; j.newU = next.u; j.newWork = nextWork;
        uint256 n = _boundaries(target, next.height) - cpBefore;
        j.checkpointHeights = new uint64[](n);
        j.checkpointU = new int64[](n);
        for (uint256 i = 0; i < n; i++) {
            uint64 h = uint64(genesis - 1 + (cpBefore + 1 + i) * target.CHECKPOINT_INTERVAL());
            j.checkpointHeights[i] = h;
            j.checkpointU[i] = int64(shadow.checkpointS(h) / shadow.UNIT());
        }
    }

    function _boundaries(ZkWujiIndex target, uint64 h) internal view returns (uint256) {
        return h + 1 < genesis ? 0 : (h + 1 - genesis) / target.CHECKPOINT_INTERVAL();
    }

    function _forge(ZkWujiIndex.Journal memory honest) internal pure returns (ZkWujiIndex.Journal memory f) {
        f = abi.decode(abi.encode(honest), (ZkWujiIndex.Journal));
        f.newU = honest.newU + 1_000_000; // the attacker's chosen index move
    }

    function _propose(ZkWujiIndex target, ZkWujiIndex.Journal memory j) internal returns (uint256) {
        return target.foldProof(hex"c0ffee", abi.encode(j), new address[](0));
    }
}

contract ZkWujiChallengeTest is ZkChallengeBase {
    ZkWujiIndex idx;
    address constant PROVER = address(0xA11CE);
    address constant WATCHER = address(0xB0B);
    address constant BACKER = address(0xCAFE);

    function setUp() public {
        _load();
        idx = _deploy(anyProof, RelayerRewards(address(0)), 4320);
        vm.deal(WATCHER, 10 ether);
    }

    function _dispute(uint256 id) internal {
        vm.prank(WATCHER);
        idx.dispute{value: BOND}(id, new address[](0));
    }

    // ---------------------------------------------------------------- pending + finalize

    function test_aProofMovesNothingConsumersReadUntilTheWindowPasses() public {
        ZkWujiIndex.Journal memory j = _honest(idx, 60);
        uint256 id = _propose(idx, j);
        assertEq(id, 0);
        assertEq(idx.pendingCount(), 1);
        assertEq(idx.lastHeight(), anchorHeight, "finalized height unchanged");
        assertEq(idx.S(), 0, "S unchanged");
        (ZkWujiIndex.Continuity memory head,,) = idx.continuity();
        assertEq(head.height, j.newHeight, "provers build on the pending head");

        vm.warp(block.timestamp + W - 1);
        assertEq(idx.finalize(10), 0, "one second early");
        vm.warp(block.timestamp + 1);
        assertEq(idx.finalize(10), 1);
        assertEq(idx.lastHeight(), j.newHeight);
        assertEq(idx.S(), int256(j.newU) * idx.UNIT());
        assertEq(idx.pendingCount(), 0);
    }

    function test_batchesChainAndFinalizeInOrder() public {
        _propose(idx, _honest(idx, 40));
        vm.warp(block.timestamp + 1 hours);
        ZkWujiIndex.Journal memory second = _honest(idx, 40);
        _propose(idx, second);
        assertEq(idx.pendingCount(), 2);

        vm.warp(block.timestamp + W - 1 hours);
        assertEq(idx.finalize(10), 1, "only the first window has closed");
        vm.warp(block.timestamp + 1 hours);
        assertEq(idx.finalize(10), 1);
        assertEq(idx.lastHash(), second.newHash);

        ZkWujiIndex plain = _deploy(ISP1Verifier(address(0)), RelayerRewards(address(0)), 4320);
        plain.foldHeaders(_headers(anchorHeight, 40), new address[](0));
        plain.foldHeaders(_headers(plain.lastHeight(), 40), new address[](0));
        assertEq(idx.S(), plain.S(), "two proved batches equal two header batches");
    }

    function test_theHeaderPathWaitsForPendingBatches() public {
        _propose(idx, _honest(idx, 40));
        vm.expectRevert(ZkWujiIndex.BatchesPending.selector);
        idx.foldHeaders(_headers(anchorHeight, 40), new address[](0));
        vm.warp(block.timestamp + W);
        idx.finalize(1);
        idx.foldHeaders(_headers(idx.lastHeight(), 40), new address[](0));
    }

    function test_batchSizeIsCappedSoBackingFitsOneTransaction() public {
        ZkWujiIndex.Journal memory ok = _honest(idx, 250);
        _propose(idx, ok);
        ZkWujiIndex fresh = _deploy(anyProof, RelayerRewards(address(0)), 4320);
        ZkWujiIndex.Journal memory big = _honest(fresh, 251);
        vm.expectRevert(ZkWujiIndex.TooManyHeaders.selector);
        _propose(fresh, big);
    }

    function test_queueIsBounded() public {
        // A broken verifier lets anyone stack batches; MAX_PENDING bounds what `reject` must delete.
        ZkWujiIndex.Journal memory j = _forge(_honest(idx, 40));
        for (uint256 i = 0; i < idx.MAX_PENDING(); i++) {
            _propose(idx, j);
            (ZkWujiIndex.Continuity memory c, uint32[11] memory t, uint256 w) = idx.continuity();
            j = abi.decode(abi.encode(j), (ZkWujiIndex.Journal));
            j.prevHash = c.hash; j.prevHeight = c.height; j.prevBits = c.bits; j.prevTime = c.time;
            j.prevEpochStart = c.epochStart; j.prevU = c.u; j.prevTimes = t; j.prevWork = w;
            j.newHeight = c.height + 10;
        }
        vm.expectRevert(ZkWujiIndex.QueueFull.selector);
        _propose(idx, j);

        _dispute(0);
        vm.warp(block.timestamp + R + 1);
        idx.reject(0);
        assertEq(idx.pendingCount(), 0, "one rejection clears the whole forged chain");
    }

    function test_checkpointHeightsAreTheContractsNotTheProvers() public {
        ZkWujiIndex small = _deploy(anyProof, RelayerRewards(address(0)), 100);
        ZkWujiIndex.Journal memory j = _honest(small, 200);
        assertEq(j.checkpointHeights.length, 1);

        ZkWujiIndex.Journal memory v = abi.decode(abi.encode(j), (ZkWujiIndex.Journal));
        v.checkpointHeights[0] = j.checkpointHeights[0] + 1;
        vm.expectRevert(ZkWujiIndex.BadCheckpoints.selector);
        _propose(small, v);

        v = abi.decode(abi.encode(j), (ZkWujiIndex.Journal));
        v.checkpointHeights = new uint64[](0);
        v.checkpointU = new int64[](0);
        vm.expectRevert(ZkWujiIndex.BadCheckpoints.selector);
        _propose(small, v);

        _propose(small, j);
        vm.warp(block.timestamp + W);
        small.finalize(1);
        assertEq(small.checkpointS(genesis + 99), int256(j.checkpointU[0]) * small.UNIT());
    }

    function test_rewardTokenListsAreValidatedUpFront() public {
        address[] memory unsorted = new address[](2);
        unsorted[0] = address(2);
        unsorted[1] = address(1);
        ZkWujiIndex.Journal memory j = _honest(idx, 40);
        vm.expectRevert(ZkWujiIndex.BadTokens.selector);
        idx.foldProof(hex"c0ffee", abi.encode(j), unsorted);
        _propose(idx, j);
        vm.prank(WATCHER);
        vm.expectRevert(ZkWujiIndex.BadTokens.selector);
        idx.dispute{value: BOND}(0, unsorted);
    }

    // ---------------------------------------------------------------- dispute

    function test_disputeRules() public {
        _propose(idx, _honest(idx, 40));
        vm.startPrank(WATCHER);
        vm.expectRevert(ZkWujiIndex.WrongBond.selector);
        idx.dispute{value: BOND - 1}(0, new address[](0));
        vm.expectRevert(ZkWujiIndex.NoSuchBatch.selector);
        idx.dispute{value: BOND}(1, new address[](0));
        idx.dispute{value: BOND}(0, new address[](0));
        vm.expectRevert(ZkWujiIndex.AlreadyDisputed.selector);
        idx.dispute{value: BOND}(0, new address[](0));
        vm.stopPrank();

        _propose(idx, _honest(idx, 40));
        vm.warp(block.timestamp + W);
        vm.prank(WATCHER);
        vm.expectRevert(ZkWujiIndex.WindowClosed.selector);
        idx.dispute{value: BOND}(1, new address[](0));
    }

    function test_aDisputedBatchNeverFinalizesOnTime() public {
        _propose(idx, _honest(idx, 40));
        _dispute(0);
        vm.warp(block.timestamp + W + R + 365 days);
        assertEq(idx.finalize(10), 0, "the window alone never finalizes a disputed batch");
        assertEq(idx.lastHeight(), anchorHeight);
    }

    // ---------------------------------------------------------------- back

    function test_anHonestBatchIsBackedAndTheWrongDisputerPaysTheBacker() public {
        ZkWujiIndex.Journal memory j = _honest(idx, 60);
        _propose(idx, j);
        _dispute(0);

        bytes memory raw = _headers(anchorHeight, 60);
        vm.prank(BACKER);
        uint256 g = gasleft();
        idx.back(0, raw);
        emit log_named_uint("back gas, 54 folded + 6 confirmations", g - gasleft());
        assertEq(idx.owed(BACKER), BOND, "the bond pays for the backing");
        assertEq(idx.finalize(1), 1, "backed batches finalize without waiting for the window");
        assertEq(idx.lastHash(), j.newHash);

        uint256 before = BACKER.balance;
        vm.prank(BACKER);
        idx.withdraw();
        assertEq(BACKER.balance - before, BOND);
        assertEq(address(idx).balance, 0);
    }

    function test_backingStartsFromThePreviousPendingBatch() public {
        _propose(idx, _honest(idx, 40));
        ZkWujiIndex.Journal memory second = _honest(idx, 50);
        _propose(idx, second);
        _dispute(1);

        vm.prank(BACKER);
        idx.back(1, _headers(second.prevHeight, 50));
        assertEq(idx.finalize(10), 0, "still behind batch 0's window");
        vm.warp(block.timestamp + W);
        assertEq(idx.finalize(10), 2);
        assertEq(idx.lastHash(), second.newHash);
    }

    function test_aBackedBatchWithCheckpointsMatches() public {
        ZkWujiIndex small = _deploy(anyProof, RelayerRewards(address(0)), 100);
        ZkWujiIndex.Journal memory j = _honest(small, 220);
        assertEq(j.checkpointHeights.length, 2);
        _propose(small, j);
        vm.prank(WATCHER);
        small.dispute{value: BOND}(0, new address[](0));
        small.back(0, _headers(anchorHeight, 220));

        // a forged checkpoint value is caught by backing even though the end state is real
        ZkWujiIndex other = _deploy(anyProof, RelayerRewards(address(0)), 100);
        ZkWujiIndex.Journal memory f = abi.decode(abi.encode(j), (ZkWujiIndex.Journal));
        f.checkpointU[1] += 1;
        _propose(other, f);
        vm.prank(WATCHER);
        other.dispute{value: BOND}(0, new address[](0));
        vm.expectRevert(ZkWujiIndex.Mismatch.selector);
        other.back(0, _headers(anchorHeight, 220));
    }

    function test_aForgedBatchCannotBeBacked() public {
        ZkWujiIndex.Journal memory honest = _honest(idx, 60);
        _propose(idx, _forge(honest));
        _dispute(0);

        bytes memory real = _headers(anchorHeight, 60);
        vm.expectRevert(ZkWujiIndex.Mismatch.selector);
        idx.back(0, real);
        vm.expectRevert(ZkWujiIndex.BadLength.selector);
        idx.back(0, _headers(anchorHeight, 61));
        bytes memory tampered = real;
        tampered[76] = bytes1(uint8(tampered[76]) ^ 1); // the first header's nonce
        vm.expectRevert(ZkWujiIndex.BadWork.selector);
        idx.back(0, tampered);
    }

    function test_backingAfterTheResponseWindowIsTooLate() public {
        _propose(idx, _honest(idx, 40));
        _dispute(0);
        vm.warp(block.timestamp + R + 1);
        vm.expectRevert(ZkWujiIndex.WindowClosed.selector);
        idx.back(0, _headers(anchorHeight, 40));
    }

    function test_onlyDisputedBatchesCanBeBacked() public {
        _propose(idx, _honest(idx, 40));
        vm.expectRevert(ZkWujiIndex.NotDisputed.selector);
        idx.back(0, _headers(anchorHeight, 40));
    }

    // ---------------------------------------------------------------- reject

    function test_aForgedBatchIsRejectedWithEverythingBuiltOnIt() public {
        ZkWujiIndex.Journal memory honest = _honest(idx, 60);
        ZkWujiIndex.Journal memory forged = _forge(honest);
        _propose(idx, forged);

        // someone chains another batch on the forged head, and a second watcher disputes that one too
        ZkWujiIndex.Journal memory onTop = abi.decode(abi.encode(forged), (ZkWujiIndex.Journal));
        onTop.prevU = forged.newU; onTop.prevHash = forged.newHash; onTop.prevHeight = forged.newHeight;
        onTop.prevBits = forged.newBits; onTop.prevTime = forged.newTime; onTop.prevEpochStart = forged.newEpochStart;
        onTop.prevTimes = forged.newTimes; onTop.prevWork = forged.newWork; onTop.newHeight = forged.newHeight + 30;
        _propose(idx, onTop);
        address second = address(0xD00D);
        vm.deal(second, 1 ether);
        vm.prank(second);
        idx.dispute{value: BOND}(1, new address[](0));

        _dispute(0);
        vm.expectRevert(ZkWujiIndex.WindowOpen.selector);
        idx.reject(0);
        vm.warp(block.timestamp + R + 1);
        idx.reject(0);

        assertEq(idx.pendingCount(), 0);
        assertEq(idx.nextBatch(), 0, "the next proof reuses the id");
        assertEq(idx.lastHeight(), anchorHeight, "the forgery never touched the index");
        assertEq(idx.owed(WATCHER), BOND, "disputer refunded");
        assertEq(idx.owed(second), BOND, "a disputer of a removed later batch is refunded too");
        assertEq(address(idx).balance, 2 * BOND, "bonds conserved");

        // the honest batch can now be proved from the finalized state
        _propose(idx, honest);
        vm.warp(block.timestamp + W);
        idx.finalize(1);
        assertEq(idx.lastHash(), honest.newHash);
    }

    // ---------------------------------------------------------------- refute

    function test_aForgedBatchIsRefutedAtOnceAndTheHeaderPathAdvances() public {
        ZkWujiIndex.Journal memory honest = _honest(idx, 60);
        _propose(idx, _forge(honest));
        _dispute(0);

        address refuter = address(0xF00D);
        vm.prank(refuter);
        uint64 folded = idx.refute(0, _headers(anchorHeight, 60), new address[](0));
        assertEq(folded, 54);
        assertEq(idx.pendingCount(), 0, "the forgery is gone without waiting for the response window");
        assertEq(idx.lastHash(), honest.newHash, "and the real state is folded in its place");
        assertEq(idx.S(), int256(honest.newU) * idx.UNIT());
        assertEq(idx.owed(WATCHER), BOND, "the disputer was right and gets the bond back");
    }

    /// Why `refute` cannot require "strictly more work" (docs/reviews/2026-10-02-T12-refute-work.md): the
    /// refuting headers cover exactly the batch's range, so at equal difficulty a forgery that claims honest
    /// bits claims exactly the work the real headers have. A strict comparison would leave every such forgery
    /// to wait out the response window, which is the liveness hole `refute` closed (WUJI-08).
    function test_aForgeryClaimingHonestWorkIsRefutedEvenThoughTheWorkIsEqual() public {
        ZkWujiIndex.Journal memory honest = _honest(idx, 60);
        ZkWujiIndex.Journal memory forged = _forge(honest); // same bits, same work, different U
        _propose(idx, forged);
        assertEq(idx.batch(0).toWork, honest.newWork, "the forgery's claimed work equals the real chain's");
        _dispute(0);
        idx.refute(0, _headers(anchorHeight, 60), new address[](0));
        assertEq(idx.lastHash(), honest.newHash);
    }

    function test_refutingAnHonestBatchFails() public {
        _propose(idx, _honest(idx, 60));
        _dispute(0);
        vm.expectRevert(ZkWujiIndex.NotForged.selector);
        idx.refute(0, _headers(anchorHeight, 60), new address[](0));
    }

    function test_refuteNeedsADispute() public {
        _propose(idx, _forge(_honest(idx, 60)));
        vm.expectRevert(ZkWujiIndex.NotDisputed.selector);
        idx.refute(0, _headers(anchorHeight, 60), new address[](0));
    }

    function test_refutingALaterBatchRemovesItAndLeavesTheEarlierOnes() public {
        ZkWujiIndex.Journal memory first = _honest(idx, 40);
        _propose(idx, first);
        ZkWujiIndex.Journal memory second = _honest(idx, 40);
        _propose(idx, _forge(second));
        _dispute(1);
        idx.refute(1, _headers(first.newHeight, 40), new address[](0));
        assertEq(idx.pendingCount(), 1, "only the forged batch went");
        assertEq(idx.lastHeight(), anchorHeight, "nothing is folded past an unfinalized batch");
        vm.warp(block.timestamp + W);
        idx.finalize(1);
        assertEq(idx.lastHash(), first.newHash);
    }

    /// The liveness property the header path exists for: a broken verifier and an attacker who always
    /// occupies the head of the queue cannot stop the index, because every forgery is refuted with real headers.
    function test_forgedProofsCannotHoldTheIndex() public {
        for (uint256 round = 0; round < 3; round++) {
            uint64 before = idx.lastHeight();
            ZkWujiIndex.Journal memory honest = _honest(idx, 40);
            _propose(idx, _forge(honest));
            _dispute(idx.firstPending());
            idx.refute(idx.firstPending(), _headers(before, 40), new address[](0));
            assertEq(idx.lastHash(), honest.newHash, "advanced past the forgery");
        }
        assertEq(idx.lastHeight(), anchorHeight + 3 * 34);
    }

    function test_rejectNeedsAnUnansweredDispute() public {
        _propose(idx, _honest(idx, 40));
        vm.expectRevert(ZkWujiIndex.NotDisputed.selector);
        idx.reject(0);
        _dispute(0);
        idx.back(0, _headers(anchorHeight, 40));
        vm.warp(block.timestamp + R + 1);
        vm.expectRevert(ZkWujiIndex.NotDisputed.selector);
        idx.reject(0);
    }

    // ---------------------------------------------------------------- construction

    function test_aProofPathNeedsAWindowAResponseAndABond() public {
        bytes memory anchor = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        uint32[11] memory times;
        ZkWujiIndex.Challenge[3] memory bad = [
            ZkWujiIndex.Challenge({window: 0, responseWindow: R, bond: BOND}),
            ZkWujiIndex.Challenge({window: W, responseWindow: 0, bond: BOND}),
            ZkWujiIndex.Challenge({window: W, responseWindow: R, bond: 0})
        ];
        for (uint256 i = 0; i < 3; i++) {
            vm.expectRevert(ZkWujiIndex.ConfigMismatch.selector);
            new ZkWujiIndex(
                anyProof, bytes32(uint256(1)), RelayerRewards(address(0)), anchor, anchorHeight, 1, times, 0, genesis,
                4320, bad[i]
            );
        }
        // a header-path-only deployment needs none of them
        new ZkWujiIndex(
            ISP1Verifier(address(0)), bytes32(0), RelayerRewards(address(0)), anchor, anchorHeight, 1, times, 0,
            genesis, 4320, ZkWujiIndex.Challenge({window: 0, responseWindow: 0, bond: 0})
        );
    }
}

/// Relayer bounties under the window: the prover is paid on finalize, the watcher on reject.
contract ZkWujiChallengeRewardsTest is ZkChallengeBase {
    ZkWujiIndex idx;
    RelayerRewards rewards;
    MockUSDT token;
    address constant PROVER = address(0xA11CE);
    address constant WATCHER = address(0xB0B);

    function setUp() public {
        _load();
        // RelayerRewards binds the index address before the index exists: predict it (next CREATE).
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        rewards = new RelayerRewards(predicted, genesis);
        idx = _deploy(anyProof, rewards, 4320);
        assertEq(address(idx), predicted);
        token = new MockUSDT();
        token.mint(address(this), 1_000_000_000);
        token.approve(address(rewards), type(uint256).max);
        rewards.fund(address(token), 1_000_000_000);
        vm.deal(WATCHER, 1 ether);
    }

    function _one() internal view returns (address[] memory list) {
        list = new address[](1);
        list[0] = address(token);
    }

    function test_theProverChoosesTokensAndIsPaidOnlyOnFinalize() public {
        ZkWujiIndex.Journal memory j = _honest(idx, 40);
        vm.prank(PROVER);
        idx.foldProof(hex"c0ffee", abi.encode(j), _one());
        assertEq(rewards.claimable(address(token), PROVER), 0, "nothing while pending");
        vm.warp(block.timestamp + W);
        idx.finalize(1); // called by someone else, who cannot change the prover's token list
        uint256 heights = j.newHeight - j.prevHeight;
        assertEq(rewards.claimable(address(token), PROVER), _bountyFor(1_000_000_000, heights));
        assertEq(rewards.lastHeight(), j.newHeight);
    }

    function test_aRejectedBatchPaysItsBountyToTheDisputer() public {
        ZkWujiIndex.Journal memory j = _forge(_honest(idx, 40));
        vm.prank(PROVER);
        idx.foldProof(hex"c0ffee", abi.encode(j), _one());
        vm.prank(WATCHER);
        idx.dispute{value: BOND}(0, _one());
        vm.warp(block.timestamp + R + 1);
        idx.reject(0);
        uint256 heights = j.newHeight - j.prevHeight;
        assertEq(rewards.claimable(address(token), WATCHER), _bountyFor(1_000_000_000, heights));
        assertEq(rewards.claimable(address(token), PROVER), 0);
        assertEq(rewards.lastHeight(), genesis - 1, "rejected heights stay payable to whoever folds them for real");
    }

    function _bountyFor(uint256 balance, uint256 count) internal pure returns (uint256) {
        uint256 remaining = balance;
        for (uint256 i; i < count; ++i) remaining -= remaining / 10_000;
        return balance - remaining;
    }
}
