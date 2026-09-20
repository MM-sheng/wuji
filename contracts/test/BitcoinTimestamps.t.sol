// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BitcoinRelayTest,EasyRelay} from "./BitcoinRelay.t.sol";
import {BitcoinRelay} from "../src/BitcoinRelay.sol";
import {BitcoinRelayPackedBaseline} from "./reference/BitcoinRelayPackedBaseline.sol";
import {WujiIndex} from "../src/WujiIndex.sol";
import {RelayerRewards} from "../src/RelayerRewards.sol";
import {MockUSDT} from "./mocks/MockUSDT.sol";

// Deliberately bypasses historical acceptance to test a supplied parent window against Core vectors.
// Production has no seeding function or easy-PoW flag.
contract TimestampHarness is EasyRelay {
    constructor(bytes memory cp,bytes memory ancestors) EasyRelay(cp,ancestors) {}
    function checkVersion(int32 version,uint64 height) external pure { _checkVersion(version,height); }
    function seedWindow(uint32[11] memory times,uint256 tag) external returns(bytes32 parent) {
        parent=checkpointHash;
        for(uint32 i;i<11;++i){bytes32 hash=keccak256(abi.encode(tag,i));_insert(hash,parent,Info(1001+i,times[i],1,0));parent=hash;}
    }
}
contract BitcoinTimestampsTest is BitcoinRelayTest {
    function test_shallowForkRewireGas() public {
        EasyRelay r=new EasyRelay(cp,ancestors);
        extend(r,r.bestHash(),10,1);
        bytes32 parent=extend(r,r.headerAt(1007),3,100);
        assertEq(r.bestHeight(),1010);assertNotEq(r.bestHash(),parent);
        bytes memory h=next(r,parent,103);warpHeaders(h);
        uint256 beforeGas=gasleft();r.submit(h);
        emit log_named_uint("synthetic fourth fork header plus four-height rewire execution gas",beforeGas-gasleft());
        assertEq(r.bestHeight(),1011);assertEq(r.bestHash(),sha256(abi.encodePacked(sha256(h))));
        assertEq(r.headerAt(1010),parent);
    }
    function test_mainnetVersionActivationBoundariesAndSignedness() public {
        TimestampHarness r=new TimestampHarness(cp,ancestors);
        r.checkVersion(1,227930);vm.expectRevert("bad-version");r.checkVersion(1,227931);
        r.checkVersion(2,363724);vm.expectRevert("bad-version");r.checkVersion(2,363725);
        r.checkVersion(3,388380);vm.expectRevert("bad-version");r.checkVersion(3,388381);
        r.checkVersion(4,388381);vm.expectRevert("bad-version");r.checkVersion(type(int32).min,798336);
        bytes memory h=slice(headers,0,80);h[0]=0x03;h[1]=0;h[2]=0;h[3]=0;
        vm.expectRevert("bad-version");relay.submit(h);
    }
    function mine(bytes32 parent,uint32 time,uint256 salt) internal view returns(bytes memory h) {
        h=new bytes(80);for(uint256 i;i<32;++i)h[4+i]=parent[i];
        for(uint256 i;i<4;++i){h[68+i]=bytes1(uint8(time>>(i*8)));h[72+i]=cp[72+i];}
        for(uint256 nonce;;++nonce){bytes32 merkle=keccak256(abi.encode(salt,nonce));for(uint256 i;i<32;++i)h[36+i]=merkle[i];
            if(uint256(relay.reverse(sha256(abi.encodePacked(sha256(h)))))<=type(uint256).max/2)return h;
        }
    }
    function test_coreDerivedWindowsAndAcceptanceBoundaries() public {
        string memory data=vm.readFile("test/fixtures/core-timestamps.json");
        uint256 length=vm.parseJsonUint(data,".count");assertEq(length,345);
        TimestampHarness r=new TimestampHarness(cp,ancestors);
        for(uint256 i;i<length;++i){
            string memory base=string.concat(".vectors[",vm.toString(i),"]");
            uint256[] memory input=vm.parseJsonUintArray(data,string.concat(base,".times"));uint32[11] memory times;
            for(uint256 k;k<11;++k)times[k]=uint32(input[k]);
            bytes32 parent=r.seedWindow(times,i);assertEq(r.medianTimePast(parent),vm.parseJsonUint(data,string.concat(base,".median")));
            vm.warp(vm.parseJsonUint(data,string.concat(base,".now")));
            bytes memory h=mine(parent,uint32(vm.parseJsonUint(data,string.concat(base,".candidate"))),i);
            bool oldOK=vm.parseJsonBool(data,string.concat(base,".afterMedian"));bool futureOK=vm.parseJsonBool(data,string.concat(base,".notFuture"));
            bytes32 previous=r.bestHash();uint64 height=r.bestHeight();
            if(!oldOK)vm.expectRevert("time-too-old");else if(!futureOK)vm.expectRevert("time-too-new");
            r.submit(h);
            if(oldOK&&futureOK)assertEq(r.heightOf(sha256(abi.encodePacked(sha256(h)))),1012);
            else {assertEq(r.bestHash(),previous);assertEq(r.bestHeight(),height);}
        }
    }
    function test_authenticatedBootstrapAndCheckpointTime() public {
        bytes memory bad=ancestors;bad[50]=bytes1(uint8(bad[50])^1);
        vm.expectRevert("checkpoint history linkage");new EasyRelay(cp,bad);
        vm.expectRevert("checkpoint history length");new EasyRelay(cp,new bytes(800));
        // Use a new read because memory assignment above aliases the array.
        bytes memory good=vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-ancestors.hex"));
        vm.warp(uint256(headerTime(cp))-7200);new EasyRelay(cp,good); // Exact future boundary is valid.
        vm.warp(uint256(headerTime(cp))-7201);vm.expectRevert("time-too-new");new EasyRelay(cp,good);
        vm.warp(headerTime(cp));
        uint32[11] memory sorted;for(uint256 i;i<11;++i)sorted[i]=headerTime(slice(good,i*80,80));
        for(uint256 i=1;i<11;++i){uint32 v=sorted[i];uint256 k=i;while(k>0&&sorted[k-1]>v){sorted[k]=sorted[k-1];--k;}sorted[k]=v;}
        bytes32 parent=sha256(abi.encodePacked(sha256(slice(good,800,80))));bytes memory early=mine(parent,sorted[5],999);
        vm.expectRevert("time-too-old");new EasyRelay(early,good);
    }
    function test_bootstrapWindowMatchesActualElevenAncestors() public {
        uint32[11] memory times;
        for(uint256 h;h<12;++h){
            // A direct reference over raw fixture bytes includes bootstrap hashes below the stored checkpoint.
            bytes memory all=bytes.concat(ancestors,cp,slice(headers,0,h*80));
            uint256 end=all.length/80;
            for(uint256 i;i<11;++i)times[i]=headerTime(slice(all,(end-11+i)*80,80));
            for(uint256 i=1;i<11;++i){uint32 v=times[i];uint256 k=i;while(k>0&&times[k-1]>v){times[k]=times[k-1];--k;}times[k]=v;}
            assertEq(relay.medianTimePast(relay.bestHash()),times[5]);
            if(h<11)submitAtTime(relay,slice(headers,h*80,80));
        }
    }
    function test_branchWindowDoesNotUseCanonicalTipTimes() public {
        TimestampHarness r=new TimestampHarness(cp,ancestors);uint32[11] memory high;uint32[11] memory low;
        uint32 start=headerTime(cp);
        for(uint32 i;i<11;++i){high[i]=start+1000+i;low[i]=start+10+i;}
        bytes32 a=r.seedWindow(high,1);bytes32 b=r.seedWindow(low,2);vm.warp(start+1100);
        r.submit(mine(a,start+1011,1)); // Install the higher-time branch first.
        assertEq(r.medianTimePast(b),start+15);
        bytes memory branch=mine(b,start+16,2);r.submit(branch); // Below the other branch's median, valid here.
        bytes memory invalid=mine(a,start+16,3);vm.expectRevert("time-too-old");r.submit(invalid);
    }
    function test_staleGateIsAtomicAndPermissionlessCatchupRecovers() public {
        uint64 nonce=vm.getNonce(address(this));RelayerRewards rewards=new RelayerRewards(vm.computeCreateAddress(address(this),nonce+2),1001);
        EasyRelay r=new EasyRelay(cp,ancestors);WujiIndex idx=new WujiIndex(r,1001,4,rewards);
        MockUSDT token=new MockUSDT();token.mint(address(rewards),1_000_000);rewards.sync(address(token));
        address[] memory list=new address[](1);list[0]=address(token);
        vm.warp(uint256(headerTime(cp))+3 hours+1);assertFalse(idx.relayFresh());assertEq(idx.fold(),0); // Empty bootstrap.
        extend(r,r.bestHash(),10,1);uint32 lastTime=r.timestampOf(r.bestHash());vm.warp(uint256(lastTime)+3 hours+2);
        assertEq(idx.pending(),4);bytes32 before=r.bestHash();bytes memory oldHeader=mine(before,lastTime+1,700);
        vm.expectRevert("relay stale");idx.fold();
        vm.expectRevert("relay stale");idx.fold(0);
        vm.expectRevert("relay stale");idx.fold(16,list);
        vm.expectRevert("relay stale");idx.submitAndFold(oldHeader,16,list);
        assertEq(r.bestHash(),before);assertEq(idx.S(),0);assertEq(idx.lastHeight(),1000);assertFalse(idx.checkpointed(1004));
        assertEq(rewards.lastHeight(),1000);assertEq(rewards.claimable(address(token),address(this)),0);
        r.submit(oldHeader); // Standalone relay remains live during catch-up.
        bytes memory fresh=mine(r.bestHash(),uint32(block.timestamp),701);r.submit(fresh);assertTrue(idx.relayFresh());
        uint256 expected=rewards.quote(address(token),6);assertEq(idx.fold(16,list),6);
        assertEq(idx.lastHeight(),1006);assertTrue(idx.checkpointed(1004));assertEq(rewards.claimable(address(token),address(this)),expected);
    }
    function test_exactFreshnessBoundaryAndDeepReorgPrecedence() public {
        EasyRelay r=new EasyRelay(cp,ancestors);bytes32 root=r.bestHash();extend(r,root,10,1);
        WujiIndex idx=new WujiIndex(r,1001,4320,RelayerRewards(address(0)));
        vm.warp(uint256(r.timestampOf(r.bestHash()))+3 hours);assertTrue(idx.relayFresh());assertEq(idx.fold(),4);
        vm.warp(block.timestamp+1);assertFalse(idx.relayFresh());
        extend(r,root,12,100);vm.expectRevert("deep Bitcoin reorg");idx.fold(0);
    }
    // Three overlapping windows cover every one of the 6060 headers and all four retargets.
    // Each fits the unchanged Foundry transaction gas limit; no test executor budget is increased.
    function test_firstEpochMatchesReference() public { checkEpoch(0); }
    function test_secondEpochMatchesReference() public { checkEpoch(2016); }
    function test_thirdEpochMatchesReference() public { checkEpoch(4032); }
    function checkEpoch(uint256 offset) internal {
        string memory data=vm.readFile("test/fixtures/bitcoin-timestamps.json");
        bytes memory all=vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps.hex"));
        bytes memory refs=vm.parseBytes(vm.readFile("test/fixtures/bitcoin-timestamps-vectors.hex"));
        uint256[] memory medians=vm.parseJsonUintArray(data,".mtp");
        bytes memory prefix=bytes.concat(ancestors,cp,all);
        bytes memory anchor=slice(prefix,(offset+11)*80,80);
        bytes memory history=slice(prefix,offset*80,880);
        uint64 start=uint64(798336+offset);uint32 epochTime=offset==0?uint32(vm.parseJsonUint(meta,".epochStartTime")):headerTime(slice(all,(offset-2016)*80,80));
        vm.warp(headerTime(anchor));
        relay=new BitcoinRelay(anchor,start-1,epochTime,1e30,history);
        BitcoinRelayPackedBaseline old=new BitcoinRelayPackedBaseline(anchor,start-1,epochTime,1e30);
        WujiIndex idx=new WujiIndex(relay,start,12,RelayerRewards(address(0)));int256 expected;
        for(uint256 i=offset;i<offset+2028;i+=24){
            uint256 n=offset+2028-i;if(n>24)n=24;bytes memory batch=slice(all,i*80,n*80);warpHeaders(batch);old.submit(batch);relay.submit(batch);
            assertEq(relay.bestHash(),old.bestHash());assertEq(relay.chainWork(relay.bestHash()),old.chainWork(old.bestHash()));
            expected+=compareWindow(old,idx,refs,medians,i,n);
        }
        assertEq(relay.bestHeight(),start+2027);idx.fold(3000);assertEq(idx.lastHeight(),start+2021);
        compareIndex(idx,refs,offset,expected);
    }
    function compareIndex(WujiIndex idx,bytes memory refs,uint256 offset,int256 expected) internal view {
        int256 finalS;int256 boundaryS;int256 total;
        for(uint256 i;i<2028;++i){int256 delta=idx.increment(bytes32(slice(refs,(offset+i)*32,32)));total+=delta;if(i<2022)finalS+=delta;if(i<12)boundaryS+=delta;}
        uint64 boundary=idx.GENESIS_HEIGHT()+11;
        assertEq(total,expected);assertEq(idx.S(),finalS);assertTrue(idx.checkpointed(boundary));assertEq(idx.checkpointS(boundary),boundaryS);
    }
    function compareWindow(BitcoinRelayPackedBaseline old,WujiIndex idx,bytes memory refs,uint256[] memory medians,uint256 start,uint256 count) internal view returns(int256 sum) {
        for(uint256 k=start;k<start+count;++k){
            uint64 height=uint64(798336+k);bytes32 hash=relay.headerAt(height);
            bytes32 parent=relay.headerAt(height-1);
            assertEq(hash,old.headerAt(height));assertEq(relay.chainWork(hash),old.chainWork(hash));assertEq(relay.medianTimePast(parent),medians[k]);
            bytes32 R=sha256(abi.encodePacked(hash));assertEq(R,bytes32(slice(refs,k*32,32)));sum+=idx.increment(R);
        }
    }
}
