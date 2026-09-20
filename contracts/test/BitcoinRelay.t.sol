// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {WujiVault} from "../src/WujiVault.sol";
import {SeriesTokenDeployer} from "../src/SeriesToken.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

// Fork-choice tests use easy PoW only in this subclass. Real tests deploy the unmodified production relay.
contract EasyRelay is BitcoinRelay {
    mapping(bytes32 => bytes32) private testParents;
    function _storeLink(bytes32 hash,bytes32 parent,uint32 id) internal override {
        testParents[hash] = parent; super._storeLink(hash,bytes32(0),id);
    }
    function _parent(bytes32 hash) internal view override returns(bytes32) { return testParents[hash]; }
    constructor(bytes memory cp, bytes memory ancestors) BitcoinRelay(cp,1000,0,1e30,ancestors) {}
    function targetOf(uint32) public pure override returns(uint256) { return type(uint256).max/2; }
}
contract BitcoinRelayTest is Test {
    bytes headers; bytes vectors; bytes cp; bytes ancestors; string meta;
    BitcoinRelay relay;
    function setUp() public {
        meta=vm.readFile("test/fixtures/bitcoin.json");
        cp=vm.parseBytes(string.concat("0x",vm.parseJsonString(meta,".checkpointHeader")));
        headers=vm.parseBytes(vm.readFile("test/fixtures/bitcoin-798336.hex"));
        vectors=vm.parseBytes(vm.readFile("test/fixtures/bitcoin-vectors.hex"));
        ancestors=vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        vm.warp(headerTime(cp));
        relay=new BitcoinRelay(cp,798335,uint32(vm.parseJsonUint(meta,".epochStartTime")),1e30,ancestors);
    }
    function slice(bytes memory b,uint256 start,uint256 count) internal pure returns(bytes memory out) {
        require(start<=b.length && count<=b.length-start,"test slice range");
        out=new bytes(count);
        assembly ("memory-safe") { mcopy(add(out,32),add(add(b,32),start),count) }
    }
    function headerTime(bytes memory h) internal pure returns(uint32 time) {
        for(uint256 i;i<4;++i) time |= uint32(uint8(h[68+i])) << (8*i);
    }
    function warpHeaders(bytes memory batch) internal {
        uint256 nowTime=block.timestamp;
        for(uint256 i;i+80<=batch.length;i+=80) {
            uint32 time;for(uint256 k;k<4;++k)time|=uint32(uint8(batch[i+68+k]))<<(8*k);
            if(time>nowTime)nowTime=time;
        }
        vm.warp(nowTime);
    }
    function submitAtTime(BitcoinRelay r,bytes memory batch) internal { warpHeaders(batch);r.submit(batch); }
    function test_realRetargetAndEveryJsVector() public {
        bytes memory all=headers; bytes memory refs=vectors;
        WujiIndex idx=new WujiIndex(relay,798336,4320, RelayerRewards(address(0)));
        int256 expected;
        for(uint64 i;i<2028;i++) {
            bytes memory h=slice(all,uint256(i)*80,80);
            bytes32 R=sha256(abi.encodePacked(sha256(abi.encodePacked(sha256(h)))));
            assertEq(R,bytes32(slice(refs,uint256(i)*32,32)));
            expected+=idx.increment(R);
            submitAtTime(relay,h);
            assertEq(relay.headerAt(798336+i),sha256(abi.encodePacked(sha256(h))));
        }
        assertEq(expected,vm.parseInt(vm.parseJsonString(meta,".S_wad")));
        assertEq(relay.bestHeight(),800363);
        idx.fold(3000);
        int256 finalized;
        for(uint256 i;i<2022;i++) finalized+=idx.increment(bytes32(slice(refs,i*32,32)));
        assertEq(idx.lastHeight(),800357);assertEq(idx.S(),finalized);
        assertEq(sha256(abi.encodePacked(relay.headerAt(800000))),0x74323d1b46bfc56d162ea5725ebc666028c5ee2b0a4824e32dedff53fe3ec1fd);
    }
    function test_rejectsFlippedBit() public {
        bytes memory h=slice(headers,0,80);h[40]=bytes1(uint8(h[40])^1);
        vm.expectRevert(bytes("PoW"));submitAtTime(relay,h);
    }
    function test_rejectsWrongRetargetBits() public {
        // First fixture header is also an epoch boundary (798336 % 2016 == 0).
        bytes memory h=slice(headers,0,80);h[72]=bytes1(uint8(h[72])^1);
        vm.expectRevert("difficulty");submitAtTime(relay,h);
    }
    function test_rejectsMalformedUnknownParentAndDisjointBatch() public {
        vm.expectRevert("header length");submitAtTime(relay,hex"00");
        vm.expectRevert("unknown parent");submitAtTime(relay,slice(headers,80,80));
        vm.expectRevert("batch linkage");submitAtTime(relay,bytes.concat(slice(headers,0,80),slice(headers,160,80)));
        assertEq(relay.bestHeight(),798335);
    }
    function test_targetsAndClamp() public {
        vm.expectRevert("target sign/zero");relay.targetOf(0x1d80ffff);
        vm.expectRevert("target overflow");relay.targetOf(0x23000001);
        vm.expectRevert("target range");relay.targetOf(0x1e00ffff);
        uint32 bits=0x17053894;
        assertEq(relay.retarget(bits,100,99),relay.compact(relay.targetOf(bits)/4));
        assertEq(relay.retarget(bits,100,10_000_000),relay.compact(relay.targetOf(bits)*4));
        assertEq(relay.retarget(0x1d00ffff,0,10_000_000),0x1d00ffff);
    }
    function next(EasyRelay r,bytes32 parent,uint256 salt) internal returns(bytes memory h) {
        h=new bytes(80);
        // Use checkpoint bits unchanged; the test-only relay replaces their target with easy work.
        for(uint256 i;i<32;i++) h[4+i]=parent[i];
        for(uint256 i;i<4;i++) { h[72+i]=cp[72+i]; h[68+i]=bytes1(uint8((r.timestampOf(parent)+1)>>(8*i))); }
        for(uint256 nonce;;nonce++) {
            bytes32 merkle=keccak256(abi.encode(salt,nonce));for(uint256 i;i<32;i++) h[36+i]=merkle[i];
            if(uint256(r.reverse(sha256(abi.encodePacked(sha256(h)))))<=type(uint256).max/2) return h;
        }
    }
    function extend(EasyRelay r,bytes32 parent,uint256 count,uint256 salt) internal returns(bytes32 hash) {
        hash=parent;for(uint256 i;i<count;i++){bytes memory h=next(r,hash,salt+i);submitAtTime(r,h);hash=sha256(abi.encodePacked(sha256(h)));}
    }
    function test_threeBlockForkAndDeepReorg() public {
        EasyRelay r=new EasyRelay(cp,ancestors);
        bytes32 root=r.bestHash(); extend(r,root,10,1);
        WujiIndex idx=new WujiIndex(BitcoinRelay(address(r)),1001,4320, RelayerRewards(address(0)));idx.fold();assertEq(idx.lastHeight(),1004);
        bytes32 ancestor=r.headerAt(1007);bytes32 heavier=extend(r,ancestor,4,100);
        assertEq(r.bestHash(),heavier);assertEq(r.bestHeight(),1011);idx.fold();assertEq(idx.lastHeight(),1005);
        extend(r,root,12,200);assertEq(r.bestHeight(),1012);
        vm.expectRevert("deep Bitcoin reorg");idx.fold();
    }
    function synthetic(BitcoinRelay r,bytes32 parent,uint32 bits,uint32 time,uint256 tag) internal returns(bytes32 hash) {
        bytes memory h=new bytes(80);for(uint256 i;i<32;i++)h[4+i]=parent[i];
        for(uint256 i;i<4;i++){h[68+i]=bytes1(uint8(time>>(8*i)));h[72+i]=bytes1(uint8(bits>>(8*i)));}
        // Only this branch-choice unit test stubs SHA256, so real difficulty arithmetic can be
        // tested on competing branches without mining mainnet-difficulty orphan headers.
        bytes32 first=keccak256(abi.encode(tag));hash=bytes32(tag<<248);
        vm.mockCall(address(2),h,abi.encode(first));vm.mockCall(address(2),abi.encode(first),abi.encode(hash));
        submitAtTime(r,h);vm.clearMockedCalls();
    }
    function test_shorterButHigherWorkForkWinsAtRetarget() public {
        uint32 time=uint32(uint8(cp[68]))|uint32(uint8(cp[69]))<<8|uint32(uint8(cp[70]))<<16|uint32(uint8(cp[71]))<<24;
        uint32 bits=uint32(uint8(cp[72]))|uint32(uint8(cp[73]))<<8|uint32(uint8(cp[74]))<<16|uint32(uint8(cp[75]))<<24;
        BitcoinRelay r=new BitcoinRelay(cp,2014,time-1209600,1e30,ancestors);
        bytes32 root=r.bestHash();bytes32 tip=synthetic(r,root,bits,time+3*1209600,1);
        uint32 easier=r.retarget(bits,time-1209600,time+3*1209600);
        tip=synthetic(r,tip,easier,time+3*1209600+600,2);tip=synthetic(r,tip,easier,time+3*1209600+1200,3);tip=synthetic(r,tip,easier,time+3*1209600+1800,4);
        uint256 oldWork=r.chainWork(tip);assertEq(r.bestHeight(),2018);
        bytes32 fork=synthetic(r,root,bits,time+1,5);
        uint32 harder=r.retarget(bits,time-1209600,time+1);
        fork=synthetic(r,fork,harder,time+601,6);
        assertGt(r.chainWork(fork),oldWork);assertEq(r.bestHash(),fork);assertEq(r.bestHeight(),2016);
        assertEq(r.headerAt(2018),bytes32(0));
    }
    function test_gasTableAndRealVaultSettlement() public {
        WujiIndex idx=new WujiIndex(relay,798336,12, RelayerRewards(address(0)));
        MockUSDT token=new MockUSDT();WujiVault vault=new WujiVault(token,idx,100e18,address(0x1234),new SeriesTokenDeployer());
        bytes memory batch=slice(headers,0,80);warpHeaders(batch);vm.cool(address(relay));uint256 g=gasleft();relay.submit(batch);emit log_named_uint("submit single",g-gasleft());
        batch=slice(headers,80,24*80);warpHeaders(batch);g=gasleft();relay.submit(batch);emit log_named_uint("submit per header batch24",(g-gasleft())/24);
        g=gasleft();uint64 count=idx.fold();emit log_named_uint("fold per height",(g-gasleft())/count);
        g=gasleft();vault.settle();emit log_named_uint("settle",g-gasleft());assertEq(vault.currentId(),1);
    }
}
