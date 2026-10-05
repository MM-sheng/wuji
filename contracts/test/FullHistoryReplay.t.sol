// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WujiHeaderIndex} from "../src/WujiHeaderIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";

/// Full-history replay: every Bitcoin mainnet header from height 11 to the tip minus 100, folded through the
/// production contract in SEGMENTS independently anchored pieces (so forge runs them in parallel). Each piece must
/// fold exactly to its end with the U, work and hash that scripts/replay-history.mjs computed without the contract.
/// Any real header the contract rejects (retarget, median-time-past, proof of work, linkage) fails the test.
///
/// Needs the data, so it is skipped unless WUJI_REPLAY_DIR is set:
///   node scripts/replay-history.mjs
///   cd contracts && WUJI_REPLAY_DIR=cache/replay forge test --match-contract FullHistoryReplay --gas-limit 18446744073709551615
contract FullHistoryReplayTest is Test {
    uint256 constant SEGMENTS = 24; // must equal scripts/replay-history.mjs
    uint256 constant MAX = 512; // WujiHeaderIndex.MAX_HEADERS

    function _segment(uint256 i) internal {
        string memory dir = vm.envOr("WUJI_REPLAY_DIR", string(""));
        if (bytes(dir).length == 0) {
            vm.skip(true);
            return;
        }
        string memory base = string.concat(dir, "/seg-", vm.toString(i));
        string memory j = vm.readFile(string.concat(base, ".json"));
        bytes memory bin = vm.readFileBinary(string.concat(base, ".bin"));
        uint64 anchorHeight = uint64(vm.parseJsonUint(j, ".anchorHeight"));
        uint64 end = uint64(vm.parseJsonUint(j, ".endHeight"));

        WujiHeaderIndex idx;
        {
            uint32[11] memory times;
            uint256[] memory t = vm.parseJsonUintArray(j, ".ancestorTimes");
            for (uint256 x; x < 11; x++) {
                times[x] = uint32(t[x]);
            }
            bytes memory anchor = new bytes(80);
            assembly {
                mcopy(add(anchor, 32), add(bin, 32), 80)
            }
            idx = new WujiHeaderIndex(
                RelayerRewards(address(0)),
                anchor,
                anchorHeight,
                uint32(vm.parseJsonUint(j, ".epochStart")),
                times,
                0,
                anchorHeight + 1,
                4320,
                100
            );
        }
        vm.warp(vm.parseJsonUint(j, ".now"));

        uint64 k = idx.CONFIRMATIONS();
        bytes memory buf = new bytes(MAX * 80);
        address[] memory none;
        uint64 at = anchorHeight;
        while (at < end) {
            uint256 n = end + k - at;
            if (n > MAX) n = MAX;
            uint256 off = (uint256(at) - anchorHeight + 1) * 80;
            assembly {
                mstore(buf, mul(n, 80))
                mcopy(add(buf, 32), add(add(bin, 32), off), mul(n, 80))
            }
            idx.foldHeaders(buf, none);
            uint64 next = idx.lastHeight();
            assertGt(next, at, "no progress");
            at = next;
        }

        assertEq(idx.lastHeight(), end, "end height");
        assertEq(idx.S(), vm.parseJsonInt(j, ".expectedU") * idx.UNIT(), "S");
        assertEq(idx.chainWork(), uint256(vm.parseJsonBytes32(j, ".expectedWork")), "work");
        assertEq(idx.lastHash(), vm.parseJsonBytes32(j, ".endHash"), "tip hash");
        assertEq(idx.seenHeight(), end + k, "seen height");
    }

    function test_segment00() public {
        _segment(0);
    }

    function test_segment01() public {
        _segment(1);
    }

    function test_segment02() public {
        _segment(2);
    }

    function test_segment03() public {
        _segment(3);
    }

    function test_segment04() public {
        _segment(4);
    }

    function test_segment05() public {
        _segment(5);
    }

    function test_segment06() public {
        _segment(6);
    }

    function test_segment07() public {
        _segment(7);
    }

    function test_segment08() public {
        _segment(8);
    }

    function test_segment09() public {
        _segment(9);
    }

    function test_segment10() public {
        _segment(10);
    }

    function test_segment11() public {
        _segment(11);
    }

    function test_segment12() public {
        _segment(12);
    }

    function test_segment13() public {
        _segment(13);
    }

    function test_segment14() public {
        _segment(14);
    }

    function test_segment15() public {
        _segment(15);
    }

    function test_segment16() public {
        _segment(16);
    }

    function test_segment17() public {
        _segment(17);
    }

    function test_segment18() public {
        _segment(18);
    }

    function test_segment19() public {
        _segment(19);
    }

    function test_segment20() public {
        _segment(20);
    }

    function test_segment21() public {
        _segment(21);
    }

    function test_segment22() public {
        _segment(22);
    }

    function test_segment23() public {
        _segment(23);
    }
}
