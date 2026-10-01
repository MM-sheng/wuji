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
            uint32(vm.parseJsonUint(meta, ".epochStartTime")), times, 0, anchorHeight + 1, 4320,
            ZkWujiIndex.Challenge({window: 0, responseWindow: 0, bond: 0})
        );
        vm.warp(1_800_000_000);
        idx.foldHeaders(_headers(anchorHeight, 106), new address[](0)); // finalized tip at anchor + 100
        asset = new MockUSDT();
        pool = new WujiAccounts(WujiAccounts.Config(
            asset, WujiIndex(address(idx)), 11.5e18, EPOCH, DELAY, 30 minutes, address(0xFEE), 0, 0, 1_000));
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

    function test_aPoolOnAnIndexWithoutARelayPricesByAOrB() public view {
        assertFalse(pool.RELAY_TIP());
        assertFalse(pool.INDEX_CAN_FREEZE());
    }

    // ---------------------------------------------------------------- A

    function test_APricesPastTheFinalizedTipByAMarginThatGrowsWithItsAge() public {
        uint64 last = idx.lastHeight();
        vm.warp(idx.lastTime() + 3 hours);
        assertEq(pool.finalizedMargin(), 74);
        assertTrue(pool.acceptingRequests());
        vm.prank(alice);
        uint256 id = pool.requestEnter(true, 100e18);
        (,, uint64 e,,) = pool.accounts(id);
        assertEq(e, _round(last + 74));

        vm.warp(idx.lastTime() + 12 hours);
        assertEq(pool.finalizedMargin(), 163);
        vm.warp(idx.lastTime());
        assertEq(pool.finalizedMargin(), 40, "even a brand-new tip waits for 2 h of skew at a fast rate");
    }

    /// The table itself is computed off chain (docs/tasks/T11_PERPETUAL_ACCOUNTS.md); here: it grows with age
    /// and always exceeds the expected number of blocks at the fast rate it assumes.
    function test_AMarginGrowsWithAgeAndExceedsTheExpectedBlocks() public {
        uint64 previous;
        for (uint256 h = 0; h <= 24; h++) {
            vm.warp(idx.lastTime() + h * 1 hours);
            uint64 m = pool.finalizedMargin();
            assertGt(m, previous, "monotone");
            assertGt(uint256(m) * 4, 5 * 6 * (h + 2), "above the mean at 1.25 x 6 blocks/h over age + 2 h");
            previous = m;
        }
        vm.warp(idx.lastTime() + 1 hours + 1); // a second past a whole hour rounds up
        assertEq(pool.finalizedMargin(), 64);
    }

    function test_AStopsWhenTheFinalizedTipIsADayOld() public {
        vm.warp(idx.lastTime() + 24 hours);
        assertTrue(pool.acceptingRequests());
        vm.warp(idx.lastTime() + 24 hours + 1);
        assertFalse(pool.acceptingRequests());
        vm.prank(alice);
        vm.expectRevert(bytes("index stale"));
        pool.requestEnter(true, 100e18);
    }

    // ---------------------------------------------------------------- B

    function test_BPricesFromSuppliedHeaders() public {
        uint64 last = idx.lastHeight();
        bytes memory seen = _headers(last, 30);
        vm.warp(_timeAt(last + 30) + 10 minutes);
        assertEq(pool.pricingHeightWithHeaders(seen), _round(last + 30 + DELAY));
        vm.prank(alice);
        uint256 id = pool.requestEnterWithHeaders(true, 100e18, seen);
        (,, uint64 e,,) = pool.accounts(id);
        assertEq(e, _round(last + 30 + DELAY));
        assertLt(e, last + pool.finalizedMargin(), "the fast path prices much sooner than A");
    }

    function test_BRejectsStaleOrInvalidHeaders() public {
        uint64 last = idx.lastHeight();
        bytes memory seen = _headers(last, 30);
        vm.warp(_timeAt(last + 30) + 31 minutes);
        vm.prank(alice);
        vm.expectRevert(bytes("headers stale"));
        pool.requestEnterWithHeaders(true, 100e18, seen);

        vm.warp(_timeAt(last + 30) + 1 minutes);
        bytes memory forged = _headers(last, 30);
        forged[29 * 80 + 76] = bytes1(uint8(forged[29 * 80 + 76]) ^ 1); // last header's nonce: no work
        vm.prank(alice);
        vm.expectRevert(ZkWujiIndex.BadWork.selector);
        pool.requestEnterWithHeaders(true, 100e18, forged);

        vm.prank(alice);
        vm.expectRevert(ZkWujiIndex.Linkage.selector);
        pool.requestEnterWithHeaders(true, 100e18, _headers(last + 1, 30)); // does not start at the tip
    }

    function test_BIsOnlyForPoolsWithoutARelay() public {
        FrozenExitRelayMock r = new FrozenExitRelayMock();
        WujiIndex relayIndex = new WujiIndex(BitcoinRelay(address(r)), 1000, 4320, RelayerRewards(address(0)));
        WujiAccounts relayPool = new WujiAccounts(WujiAccounts.Config(
            asset, relayIndex, 11.5e18, EPOCH, DELAY, 30 minutes, address(0xFEE), 0, 0, 1_000));
        assertTrue(relayPool.RELAY_TIP());
        bytes memory seen = _headers(idx.lastHeight(), 30); // built first: expectRevert binds the next call
        vm.expectRevert(bytes("relay pool"));
        relayPool.requestEnterWithHeaders(true, 100e18, seen);
    }

    // ---------------------------------------------------------------- A and B together

    /// A later B request prices before an earlier A request; both are processed once each, in height order.
    function test_ARequestsAndFasterBRequestsAreProcessedInHeightOrder() public {
        uint64 last = idx.lastHeight();
        vm.warp(_timeAt(last + 30) + 10 minutes);
        vm.prank(alice);
        uint256 slow = pool.requestEnter(true, 100e18);
        vm.prank(bob);
        uint256 fast = pool.requestEnterWithHeaders(false, 100e18, _headers(last, 30));
        vm.prank(bob);
        uint256 fast2 = pool.requestEnterWithHeaders(true, 50e18, _headers(last, 30));
        (,, uint64 eSlow,,) = pool.accounts(slow);
        (,, uint64 eFast,,) = pool.accounts(fast);
        (,, uint64 eFast2,,) = pool.accounts(fast2);
        assertLt(eFast, eSlow);
        assertEq(eFast, eFast2, "same epoch, queued once");
        assertEq(pool.queueLength(), 2);
        assertEq(pool.queue(0), eFast, "sorted: the earlier height first");
        assertEq(pool.queue(1), eSlow);

        // Fold past both, mark each epoch from raw headers, process in order.
        vm.warp(1_800_000_000);
        idx.foldHeaders(_headers(idx.lastHeight(), eSlow - idx.lastHeight() + 20), new address[](0));
        uint64 tipH = idx.lastHeight();
        pool.markWithHeaders(eSlow, tipH, _headers(eSlow, tipH - eSlow));
        pool.markWithHeaders(eFast, eSlow, _headers(eFast, eSlow - eFast));
        assertEq(pool.processMany(10), 2);
        (,, bool p1) = pool.epochAcc(eFast);
        (,, bool p2) = pool.epochAcc(eSlow);
        assertTrue(p1 && p2);
        assertGt(pool.valueOf(fast), 0);
    }

    function test_anEpochAtTheFinalizedTipNeedsNoHeaders() public {
        uint64 last = idx.lastHeight();
        vm.warp(_timeAt(last + 30) + 10 minutes);
        vm.prank(alice);
        uint256 id = pool.requestEnterWithHeaders(true, 100e18, _headers(last, 30));
        (,, uint64 e,,) = pool.accounts(id);
        vm.warp(1_800_000_000);
        assertFalse(pool.process(), "not folded yet");
        idx.foldHeaders(_headers(idx.lastHeight(), e - idx.lastHeight() + 6), new address[](0));
        assertEq(idx.lastHeight(), e);
        assertTrue(pool.process());
        assertEq(pool.sAt(e), idx.S());
    }

    function test_anEpochBelowTheTipWaitsForHeaders() public {
        uint64 last = idx.lastHeight();
        vm.warp(_timeAt(last + 30) + 10 minutes);
        vm.prank(alice);
        uint256 id = pool.requestEnterWithHeaders(true, 100e18, _headers(last, 30));
        (,, uint64 e,,) = pool.accounts(id);
        vm.warp(1_800_000_000);
        idx.foldHeaders(_headers(idx.lastHeight(), e - idx.lastHeight() + 20), new address[](0));
        assertFalse(pool.process(), "below the tip and not marked");
        pool.markWithHeaders(e, idx.lastHeight(), _headers(e, idx.lastHeight() - e));
        assertTrue(pool.process());
    }
}
