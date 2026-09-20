// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BitcoinRelayTest} from "./BitcoinRelay.t.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {HistoricalRewards} from "./reference/HistoricalRewards.sol";
import {BitcoinRelayBaseline} from "./reference/BitcoinRelayBaseline.sol";
// Exposes packing only for lossless-encoding tests; never deployed in production.
contract PackingHarness is BitcoinRelay {
    constructor(bytes memory cp,uint32 time) BitcoinRelay(cp,798335,time,1e30) {}
    function parentRoundTrip(bytes32 parent,uint32 id) external returns(bytes32,uint32) {
        bytes32 key=keccak256("packing test");_storeLink(key,parent,id);
        return (_parent(key),uint32(links[key]>>224));
    }
    function setCounts(uint32 nodes_,uint32 epochs_,uint32 workers_) external { nodeCount=nodes_;epochCount=epochs_;workerCount=workers_; }
}
contract RelayPackingTest is BitcoinRelayTest {
    function testFuzz_reverseMatchesReference(bytes32 value) public view {
        uint256 input = uint256(value); uint256 output;
        for(uint256 i;i<32;++i) { output = (output<<8) | (input&255); input >>= 8; }
        assertEq(relay.reverse(value),bytes32(output));
        assertEq(relay.reverse(relay.reverse(value)),value);
    }
    function test_rejectsCheckpointNarrowing() public {
        vm.expectRevert("height overflow");
        new BitcoinRelay(cp,uint64(type(uint32).max)+1,0,1e30);
        vm.expectRevert("work overflow");
        new BitcoinRelay(cp,798335,0,uint256(type(uint128).max)+1);
    }
    function test_workAdditionRejectsOverflowAtomically() public {
        BitcoinRelay r=new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),type(uint128).max);
        bytes32 root=r.bestHash();
        vm.expectRevert("work overflow");r.submit(slice(headers,0,80));
        assertEq(r.bestHash(),root); assertEq(r.bestHeight(),798335);
        assertEq(r.chainWork(root),type(uint128).max);
    }
    function test_heightAdditionRejectsOverflowAtomically() public {
        BitcoinRelay r=new BitcoinRelay(cp,type(uint32).max,0,1e30);
        vm.expectRevert("height overflow");r.submit(slice(headers,0,80));
        assertEq(r.bestHeight(),type(uint32).max);
    }
    function test_allRealHeadersMatchFrozenBaseline() public {
        BitcoinRelayBaseline old=new BitcoinRelayBaseline(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,HistoricalRewards(address(0)));
        bytes memory all = headers;
        uint256 totalGas;
        for(uint256 i;i<2028;i+=24) {
            uint256 count=2028-i;if(count>24)count=24;
            bytes memory batch=slice(all,i*80,count*80);old.submit(batch);uint256 beforeGas=gasleft();relay.submit(batch);totalGas+=beforeGas-gasleft();
            assertEq(relay.bestHash(),old.bestHash()); assertEq(relay.bestHeight(),old.bestHeight());
            for(uint256 k;k<count;++k){
                uint64 height=uint64(798336+i+k);bytes32 hash=relay.headerAt(height);
                assertEq(hash,old.headerAt(height));assertEq(relay.chainWork(hash),old.chainWork(hash));
                assertEq(relay.heightOf(hash),old.heightOf(hash));assertEq(relay.timestampOf(hash),old.timestampOf(hash));
                assertEq(relay.submitter(hash),old.submitter(hash));
            }
        }
        emit log_named_uint("2028-header amortized gas/header",totalGas/2028);
        assertLe(totalGas/2028,70_000);
    }
    function testFuzz_parentEncodingIsLossless(uint224 numeric,uint32 id) public {
        PackingHarness r=new PackingHarness(cp,uint32(vm.parseJsonUint(meta,".epochStartTime")));
        bytes32 raw=relay.reverse(bytes32(uint256(numeric)));
        (bytes32 restored,uint32 restoredId)=r.parentRoundTrip(raw,id);
        assertEq(restored,raw);assertEq(restoredId,id);
    }
    function test_parentEncodingRejectsDiscardedBits() public {
        PackingHarness r=new PackingHarness(cp,uint32(vm.parseJsonUint(meta,".epochStartTime")));
        bytes32 raw=relay.reverse(bytes32(uint256(1)<<224));
        vm.expectRevert("parent hash range");r.parentRoundTrip(raw,1);
    }
    function test_idCapacityRejectsInsteadOfAliasingRecords() public {
        PackingHarness r=new PackingHarness(cp,uint32(vm.parseJsonUint(meta,".epochStartTime")));
        bytes memory h=slice(headers,0,80);
        r.setCounts(type(uint32).max,1,0);vm.expectRevert("node capacity");r.submit(h);
        r.setCounts(1,type(uint32).max,0);vm.expectRevert("epoch capacity");r.submit(h);
        r.setCounts(1,1,type(uint32).max);vm.expectRevert("worker capacity");r.submit(h);
        assertEq(r.bestHeight(),798335);
    }
}
