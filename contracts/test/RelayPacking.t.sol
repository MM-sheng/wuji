// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BitcoinRelayTest} from "./BitcoinRelay.t.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {BitcoinRelayBaseline} from "./reference/BitcoinRelayBaseline.sol";
contract RelayPackingTest is BitcoinRelayTest {
    function testFuzz_reverseMatchesReference(bytes32 value) public view {
        uint256 input = uint256(value); uint256 output;
        for(uint256 i;i<32;++i) { output = (output<<8) | (input&255); input >>= 8; }
        assertEq(relay.reverse(value),bytes32(output));
        assertEq(relay.reverse(relay.reverse(value)),value);
    }
    function test_rejectsCheckpointNarrowing() public {
        vm.expectRevert("height overflow");
        new BitcoinRelay(cp,uint64(type(uint32).max)+1,0,1e30,RelayerRewards(address(0)));
        vm.expectRevert("work overflow");
        new BitcoinRelay(cp,798335,0,uint256(type(uint128).max)+1,RelayerRewards(address(0)));
    }
    function test_workAdditionRejectsOverflowAtomically() public {
        BitcoinRelay r=new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),type(uint128).max,RelayerRewards(address(0)));
        bytes32 root=r.bestHash();
        vm.expectRevert("work overflow");r.submit(slice(headers,0,80));
        assertEq(r.bestHash(),root); assertEq(r.bestHeight(),798335);
        assertEq(r.chainWork(root),type(uint128).max);
    }
    function test_heightAdditionRejectsOverflowAtomically() public {
        BitcoinRelay r=new BitcoinRelay(cp,type(uint32).max,0,1e30,RelayerRewards(address(0)));
        vm.expectRevert("height overflow");r.submit(slice(headers,0,80));
        assertEq(r.bestHeight(),type(uint32).max);
    }
    function test_allRealHeadersMatchFrozenBaseline() public {
        BitcoinRelayBaseline old=new BitcoinRelayBaseline(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,RelayerRewards(address(0)));
        bytes memory all = headers;
        for(uint256 i;i<2028;i+=24) {
            uint256 count=2028-i;if(count>24)count=24;
            bytes memory batch=slice(all,i*80,count*80);old.submit(batch);relay.submit(batch);
            assertEq(relay.bestHash(),old.bestHash()); assertEq(relay.bestHeight(),old.bestHeight());
            for(uint256 k;k<count;++k){
                uint64 height=uint64(798336+i+k);bytes32 hash=relay.headerAt(height);
                assertEq(hash,old.headerAt(height));assertEq(relay.chainWork(hash),old.chainWork(hash));
                assertEq(relay.heightOf(hash),old.heightOf(hash));assertEq(relay.timestampOf(hash),old.timestampOf(hash));
                assertEq(relay.submitter(hash),old.submitter(hash));
            }
        }
    }
}
