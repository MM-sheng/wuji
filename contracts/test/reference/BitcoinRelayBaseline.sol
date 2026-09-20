// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// @notice Bitcoin mainnet SPV header relay rooted at a trusted immutable checkpoint.
/// @dev Hash keys use raw SHA256d digest order; explorer display order is reversed.
/// MTP and future-time limits are omitted; actual work is still checked and summed. No transaction validation.
import {RelayerRewards} from "../../src/RelayerRewards.sol";
// Frozen reference from 143592b, used only for differential tests.
contract BitcoinRelayBaseline {
    RelayerRewards public immutable rewards;
    mapping(bytes32 => address) public submitter;
    mapping(uint64 => bool) public rewarded;
    uint256 public constant POW_LIMIT = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    struct Node { bytes32 parent; uint256 work; uint64 height; uint32 time; uint32 bits; uint32 epochTime; bool known; }
    mapping(bytes32 => Node) internal nodes;
    mapping(uint64 => bytes32) internal main;
    bytes32 public bestHash;
    uint64 public bestHeight;
    uint64 public immutable checkpointHeight;
    bytes32 public immutable checkpointHash;
    event Header(bytes32 indexed hash, uint64 indexed height, uint256 work);
    constructor(bytes memory header, uint64 height, uint32 epochTime, uint256 work, RelayerRewards rewards_) {
        if (address(rewards_) != address(0)) require(rewards_.relay() == address(this), "reward relay mismatch");
        rewards = rewards_;
        require(header.length == 80, "header length");
        bytes32 hash = sha256(abi.encodePacked(sha256(header)));
        uint32 bits = read32(header,72); uint32 time = read32(header,68);
        uint256 target = targetOf(bits);
        require(uint256(reverse(hash)) <= target, "checkpoint PoW");
        require(work >= workOf(target), "checkpoint work");
        if (height % 2016 == 0) require(epochTime == time, "epoch time");
        checkpointHeight = height; checkpointHash = hash;
        nodes[hash] = Node(0,work,height,time,bits,epochTime,true);
        main[height] = hash; bestHeight = height; bestHash = hash;
    }
    function submit(bytes calldata headers) external {
        require(headers.length > 0 && headers.length % 80 == 0, "header length");
        bytes32 previous;
        for(uint256 o; o < headers.length; o += 80) {
            bytes memory h = headers[o:o+80]; bytes32 parent;
            assembly { parent := mload(add(h,36)) }
            if(o > 0) require(parent == previous, "batch linkage");
            bytes32 hash = sha256(abi.encodePacked(sha256(h))); previous = hash;
            if(nodes[hash].known) continue;
            Node storage p = nodes[parent]; require(p.known, "unknown parent");
            uint64 height = p.height + 1;
            uint32 bits = read32(h,72); uint32 time = read32(h,68);
            require(bits == (height % 2016 == 0 ? retarget(p.bits,p.epochTime,p.time) : p.bits), "difficulty");
            uint256 target = targetOf(bits); require(uint256(reverse(hash)) <= target, "PoW");
            uint256 work = p.work + workOf(target);
            nodes[hash] = Node(parent,work,height,time,bits,height % 2016 == 0 ? time : p.epochTime,true);
            submitter[hash] = msg.sender;
            emit Header(hash,height,work);
            if(work > nodes[bestHash].work) {
                bytes32 cursor = hash; uint64 at = height;
                while(main[at] != cursor) {
                    main[at] = cursor;
                    if(at == checkpointHeight) break;
                    cursor = nodes[cursor].parent; --at;
                }
                bestHeight = height; bestHash = hash;
            }
        }
    }
    /// @notice Only the immutable index can acknowledge a six-deep, successfully folded height.
    /// Rewards are attributed to the original submitter, never to the caller of fold.
    function rewardFinalized(uint64 height) external {
        require(address(rewards) != address(0) && msg.sender == rewards.index(), "index only");
        require(height > checkpointHeight && bestHeight >= height && bestHeight - height >= 6, "not finalized");
        if (rewarded[height]) return;
        rewarded[height] = true;
        rewards.credit(submitter[main[height]], 1);
    }
    function headerAt(uint64 height) external view returns(bytes32) { return height < checkpointHeight || height > bestHeight ? bytes32(0) : main[height]; }
    function heightOf(bytes32 hash) external view returns(uint64) { require(nodes[hash].known,"unknown header"); return nodes[hash].height; }
    function chainWork(bytes32 hash) external view returns(uint256) { return nodes[hash].work; }
    function timestampOf(bytes32 hash) external view returns(uint32) { return nodes[hash].time; }
    function targetOf(uint32 bits) public pure virtual returns(uint256 target) {
        uint256 size = bits >> 24; uint256 word = bits & 0x007fffff;
        require(word != 0 && bits & 0x00800000 == 0,"target sign/zero");
        require(size <= 34 && !(word > 0xff && size > 33) && !(word > 0xffff && size > 32),"target overflow");
        target = size <= 3 ? word >> (8*(3-size)) : word << (8*(size-3));
        require(target > 0 && target <= POW_LIMIT,"target range");
    }
    function compact(uint256 target) public pure returns(uint32) {
        uint256 size; uint256 t=target; while(t>0) { ++size; t>>=8; }
        uint256 word=size<=3 ? target << (8*(3-size)) : target >> (8*(size-3));
        if(word & 0x00800000 != 0) { word>>=8; ++size; }
        return uint32(word | size<<24);
    }
    function retarget(uint32 bits,uint32 first,uint32 last) public pure returns(uint32) {
        int256 elapsed=int256(uint256(last))-int256(uint256(first));
        if(elapsed<302400) elapsed=302400; if(elapsed>4838400) elapsed=4838400;
        uint256 t=targetOf(bits)*uint256(elapsed)/1209600;
        return compact(t>POW_LIMIT ? POW_LIMIT : t);
    }
    function workOf(uint256 target) public pure returns(uint256) { return ~target/(target+1)+1; }
    function read32(bytes memory h,uint256 at) internal pure returns(uint32) {
        return uint32(uint8(h[at])) | uint32(uint8(h[at+1]))<<8 | uint32(uint8(h[at+2]))<<16 | uint32(uint8(h[at+3]))<<24;
    }
    function reverse(bytes32 value) public pure returns(bytes32) {
        uint256 v=uint256(value); uint256 r;
        for(uint256 i;i<32;++i) { r=(r<<8)|(v&255); v>>=8; } return bytes32(r);
    }
}
