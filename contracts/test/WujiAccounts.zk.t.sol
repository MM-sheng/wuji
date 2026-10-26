// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {ZkWujiIndex, ISP1Verifier} from "../src/ZkWujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {WujiAccounts} from "../src/WujiAccounts.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {FrozenExitRelayMock} from "./mocks/FrozenExitRelayMock.sol";

/// T11 pools on an index without a header relay (ZkWujiIndex), over real mainnet headers:
/// pricing A (finalized tip + Poisson margin) by default, B (requester-supplied headers) on request.
contract WujiAccountsZkTest is Test {
    bytes headers;
    string meta;
    uint64 anchorHeight;
    ZkWujiIndex idx;
    WujiAccounts pool;
    MockUSDT asset;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint64 constant EPOCH = 6;
    uint64 constant DELAY = 2;

    function setUp() public {
        meta = vm.readFile("test/fixtures/bitcoin-timestamps.json");
        headers = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps.hex"));
        anchorHeight = uint64(vm.parseJsonUint(meta, ".checkpointHeight"));
        bytes memory anchor = vm.parseBytes(string.concat("0x", vm.parseJsonString(meta, ".checkpointHeader")));
        bytes memory ancestors = vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        uint32[11] memory times;
        for (uint256 i = 0; i < 11; i++) times[i] = _time(ancestors, i);
        // Header path only: these tests are about the pool, not the proof system.
        idx = new ZkWujiIndex(
            ISP1Verifier(address(0)), bytes32(0), RelayerRewards(address(0)), anchor, anchorHeight,
            uint32(vm.parseJsonUint(meta, ".epochStartTime")), times, 0, ZkWujiIndex.Schedule(anchorHeight + 1, 4320, 6),
            ZkWujiIndex.Challenge({window: 0, responseWindow: 0, bond: 0})
        );
        vm.warp(1_800_000_000);
        idx.foldHeaders(_headers(anchorHeight, 106), new address[](0)); // finalized tip at anchor + 100
        asset = new MockUSDT();
        pool = new WujiAccounts(WujiAccounts.Config(
            asset, WujiIndex(address(idx)), 11.5e18, EPOCH, DELAY, 30 minutes, address(0xFEE), 0, 0, 1_000, type(uint128).max, 0));
        for (uint256 i; i < 2; i++) {
            address u = [alice, bob][i];
            asset.mint(u, 1_000_000e18);
            vm.prank(u);
            asset.approve(address(pool), type(uint256).max);
        }
    }

    function _time(bytes memory h, uint256 i) internal pure returns (uint32) {
        uint256 at = i * 80 + 68;
        return uint32(uint8(h[at])) | uint32(uint8(h[at + 1])) << 8 | uint32(uint8(h[at + 2])) << 16
            | uint32(uint8(h[at + 3])) << 24;
    }

    function _headers(uint64 fromHeight, uint256 count) internal view returns (bytes memory out) {
        uint256 start = fromHeight - anchorHeight;
        out = new bytes(count * 80);
        for (uint256 i = 0; i < count * 80; i++) out[i] = headers[start * 80 + i];
    }

    /// Timestamp of the real header at `height`.
    function _timeAt(uint64 height) internal view returns (uint32) {
        return _time(headers, height - anchorHeight - 1);
    }

    function _round(uint64 h) internal pure returns (uint64) {
        return ((h + EPOCH - 1) / EPOCH) * EPOCH;
    }

    // ---------------------------------------------------------------- mode detection

    function test_aPoolOnAnIndexWithoutARelayPricesFromItsNewestValidatedHeader() public view {
        assertFalse(pool.RELAY_TIP());
        assertTrue(pool.INDEX_CAN_FREEZE(), "ZkWujiIndex has frozen() (T13 rule 3), so pools can exit");
    }

    // ---------------------------------------------------------------- the one pricing rule

    function test_aFoldRecordsTheNewestValidatedHeaderBeyondTheFinalizedTip() public view {
        assertEq(idx.lastHeight(), anchorHeight + 100);
        assertEq(idx.seenHeight(), anchorHeight + 106, "the K trailing headers were validated too");
        assertEq(idx.seenTime(), _timeAt(anchorHeight + 106));
    }

    function test_requestsArePricedPastTheNewestValidatedHeaderByTheMarginForItsAge() public {
        uint64 seen = idx.seenHeight();
        vm.warp(idx.seenTime() + 3 hours);
        assertEq(pool.seenMargin(), 74);
        assertTrue(pool.acceptingRequests());
        vm.prank(alice);
        uint256 id = pool.requestEnter(true, 100e18);
        (,, uint64 e,,) = pool.accounts(id);
        assertEq(e, _round(seen + 74));
        vm.warp(idx.seenTime());
        assertEq(pool.seenMargin(), 40, "even a brand-new header carries 2 h of skew at a fast rate");
    }

    /// The table itself is computed off chain (docs/tasks/T11_PERPETUAL_ACCOUNTS.md); here: it grows with age
    /// and always exceeds the expected number of blocks at the fast rate it assumes.
    function test_theMarginGrowsWithAgeAndExceedsTheExpectedBlocks() public {
        uint64 previous;
        for (uint256 h = 0; h <= 24; h++) {
            vm.warp(idx.seenTime() + h * 1 hours);
            uint64 m = pool.seenMargin();
            assertGt(m, previous, "monotone");
            assertGt(uint256(m) * 4, 5 * 6 * (h + 2), "above the mean at 1.25 x 6 blocks/h over age + 2 h");
            previous = m;
        }
        vm.warp(idx.seenTime() + 1 hours + 1); // a second past a whole hour rounds up
        assertEq(pool.seenMargin(), 64);
    }

    function test_requestsStopWhenTheNewestValidatedHeaderIsADayOld() public {
        vm.warp(idx.seenTime() + 24 hours);
        assertTrue(pool.acceptingRequests());
        vm.warp(idx.seenTime() + 24 hours + 1);
        assertFalse(pool.acceptingRequests());
        vm.prank(alice);
        vm.expectRevert(bytes("index stale"));
        pool.requestEnter(true, 100e18);
    }

    /// An old header with a large margin can price later than a fresh one with a small margin; both epochs are
    /// queued once, in height order, and processed in that order.
    function test_aLaterRequestCanPriceEarlierAndIsProcessedInHeightOrder() public {
        vm.warp(idx.seenTime() + 20 hours);
        vm.prank(alice);
        uint256 slow = pool.requestEnter(true, 100e18);
        idx.foldHeaders(_headers(idx.lastHeight(), 60), new address[](0)); // the seen header moves 54 ahead
        vm.prank(bob);
        uint256 fast = pool.requestEnter(false, 100e18);
        (,, uint64 eSlow,,) = pool.accounts(slow);
        (,, uint64 eFast,,) = pool.accounts(fast);
        assertLt(eFast, eSlow, "the fresher header prices earlier");
        assertEq(pool.queue(0), eFast, "sorted: the earlier height first");
        assertEq(pool.queue(1), eSlow);

        vm.warp(1_800_000_000);
        idx.foldHeaders(_headers(idx.lastHeight(), eSlow - idx.lastHeight() + 20), new address[](0));
        uint64 tipH = idx.lastHeight();
        pool.markWithHeaders(eSlow, tipH, _headers(eSlow, tipH - eSlow));
        pool.markWithHeaders(eFast, eSlow, _headers(eFast, eSlow - eFast));
        assertEq(pool.processMany(10), 2);
        (,, bool p1) = pool.epochAcc(eFast);
        (,, bool p2) = pool.epochAcc(eSlow);
        assertTrue(p1 && p2);
    }

    function test_anEpochAtTheFinalizedTipNeedsNoHeaders() public {
        vm.warp(idx.seenTime() + 10 minutes);
        vm.prank(alice);
        uint256 id = pool.requestEnter(true, 100e18);
        (,, uint64 e,,) = pool.accounts(id);
        vm.warp(1_800_000_000);
        assertFalse(pool.process(), "not folded yet");
        idx.foldHeaders(_headers(idx.lastHeight(), e - idx.lastHeight() + 6), new address[](0));
        assertEq(idx.lastHeight(), e);
        assertTrue(pool.process());
        assertEq(pool.sAt(e), idx.S());
    }

    function test_anEpochBelowTheTipWaitsForHeaders() public {
        vm.warp(idx.seenTime() + 10 minutes);
        vm.prank(alice);
        uint256 id = pool.requestEnter(true, 100e18);
        (,, uint64 e,,) = pool.accounts(id);
        vm.warp(1_800_000_000);
        idx.foldHeaders(_headers(idx.lastHeight(), e - idx.lastHeight() + 20), new address[](0));
        assertFalse(pool.process(), "below the tip and not marked");
        pool.markWithHeaders(e, idx.lastHeight(), _headers(e, idx.lastHeight() - e));
        assertTrue(pool.process());
    }
}
