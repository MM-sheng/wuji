// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// @notice Mainnet Bitcoin SPV relay. Raw SHA256d hashes use digest order, not explorer order.
/// @dev Exact work is reconstructed from branch-local difficulty epochs. No MTP/block-body checks.
contract BitcoinRelay {
    uint256 public constant POW_LIMIT = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
    // Valid mainnet hashes fit 224 bits in numeric PoW order. The remaining 32 bits identify metadata.
    mapping(bytes32 => uint256) internal links;
    // Two immutable 128-bit records per slot: height, timestamp, epoch ID, worker ID (32 bits each).
    mapping(uint256 => uint256) internal metadata;
    struct Epoch { uint128 baseWork; uint32 baseHeight; uint32 firstTime; uint32 bits; uint128 blockWork; }
    mapping(uint32 => Epoch) internal epochs;
    mapping(uint64 => bytes32) internal main;
    mapping(address => uint32) internal workerId;
    mapping(uint32 => address) internal workers;
    uint32 internal nodeCount;
    uint32 internal epochCount;
    uint32 internal workerCount;
    bytes32 public bestHash;
    uint64 public bestHeight;
    uint64 public immutable checkpointHeight;
    bytes32 public immutable checkpointHash;
    struct Info { uint32 height; uint32 time; uint32 epoch; uint32 worker; }
    event Header(bytes32 indexed hash, uint64 indexed height, uint256 work);
    constructor(bytes memory header, uint64 height, uint32 epochTime, uint256 work) {
        require(header.length == 80, "header length");
        bytes32 hash = sha256(abi.encodePacked(sha256(header)));
        uint32 bits = read32(header,72); uint32 time = read32(header,68);
        uint256 target = targetOf(bits);
        require(uint256(reverse(hash)) <= target, "checkpoint PoW");
        require(work >= workOf(target), "checkpoint work");
        if (height % 2016 == 0) require(epochTime == time, "epoch time");
        require(height <= type(uint32).max, "height overflow");
        require(work <= type(uint128).max, "work overflow");
        checkpointHeight = height; checkpointHash = hash;
        epochs[++epochCount] = Epoch(uint128(work),uint32(height),epochTime,bits,uint128(workOf(target)));
        _insert(hash,bytes32(0),Info(uint32(height),time,epochCount,0));
        main[height] = hash; bestHeight = height; bestHash = hash;
    }
    function _info(bytes32 hash) internal view returns(Info memory n) {
        uint32 id = uint32(links[hash] >> 224);
        if(id == 0) return n;
        uint256 v = metadata[id >> 1] >> ((id & 1)*128);
        n = Info(uint32(v),uint32(v>>32),uint32(v>>64),uint32(v>>96));
    }
    function _work(Info memory n, Epoch memory e) internal pure returns(uint256) {
        return uint256(e.baseWork) + uint256(n.height-e.baseHeight)*e.blockWork;
    }
    function _insert(bytes32 hash,bytes32 parent,Info memory n) internal {
        require(nodeCount < type(uint32).max, "node capacity");
        uint32 id = ++nodeCount;
        _storeLink(hash,parent,id);
        uint256 v = uint256(n.height) | uint256(n.time)<<32 | uint256(n.epoch)<<64 | uint256(n.worker)<<96;
        metadata[id>>1] |= v << ((id&1)*128);
    }
    function _storeLink(bytes32 hash,bytes32 parent,uint32 id) internal virtual {
        uint256 numeric = uint256(reverse(parent));
        require(numeric <= POW_LIMIT, "parent hash range");
        links[hash] = numeric | uint256(id)<<224;
    }
    function _parent(bytes32 hash) internal view virtual returns(bytes32) { return reverse(bytes32(links[hash] & POW_LIMIT)); }
    function _worker() internal returns(uint32 id) {
        id = workerId[msg.sender];
        if(id == 0) {
            require(workerCount < type(uint32).max, "worker capacity");
            id = ++workerCount; workerId[msg.sender] = id; workers[id] = msg.sender;
        }
    }
    function submit(bytes calldata headers) external {
        require(headers.length > 0 && headers.length % 80 == 0, "header length");
        bytes32 previous;
        uint32 worker;
        bytes32 tip = bestHash;
        uint256 tipWork = chainWork(tip);
        uint64 tipHeight = bestHeight;
        for(uint256 o; o < headers.length; o += 80) {
            bytes memory h = headers[o:o+80]; bytes32 parent;
            assembly { parent := mload(add(h,36)) }
            if(o > 0) require(parent == previous, "batch linkage");
            bytes32 hash = sha256(abi.encodePacked(sha256(h))); previous = hash;
            if(links[hash] != 0) continue;
            if(worker == 0) worker = _worker();
            (uint64 height,uint256 work) = _accept(h,hash,parent,worker);
            emit Header(hash,height,work);
            if(work > tipWork) {
                if(parent == tip) main[height] = hash;
                else {
                    bytes32 cursor = hash; uint64 at = height;
                    while(main[at] != cursor) {
                        main[at] = cursor;
                        if(at == checkpointHeight) break;
                        cursor = _parent(cursor); --at;
                    }
                }
                tipHeight = height; tip = hash; tipWork = work;
            }
        }
        bestHeight = tipHeight; bestHash = tip;
    }
    function _accept(bytes memory h,bytes32 hash,bytes32 parent,uint32 worker) internal returns(uint64 height,uint256 work) {
        require(links[parent] != 0, "unknown parent");
        Info memory p = _info(parent);
        Epoch memory e = epochs[p.epoch];
        height = uint64(p.height)+1;
        require(height <= type(uint32).max, "height overflow");
        uint32 bits = read32(h,72); uint32 time = read32(h,68);
        bool boundary = height % 2016 == 0;
        require(bits == (boundary ? retarget(e.bits,e.firstTime,p.time) : e.bits), "difficulty");
        uint256 target = targetOf(bits);
        require(uint256(reverse(hash)) <= target, "PoW");
        uint256 blockWork = workOf(target);
        work = _work(p,e) + blockWork;
        require(work <= type(uint128).max, "work overflow");
        uint32 epoch = p.epoch;
        if(boundary) {
            require(epochCount < type(uint32).max, "epoch capacity");
            epoch = ++epochCount;
            epochs[epoch] = Epoch(uint128(work),uint32(height),time,bits,uint128(blockWork));
        }
        _insert(hash,parent,Info(uint32(height),time,epoch,worker));
    }
    /// @notice Original worker via an immutable ID. Constant-time lookup, including orphan branches.
    function submitter(bytes32 hash) public view returns(address) { return workers[_info(hash).worker]; }
    function headerAt(uint64 height) external view returns(bytes32) { return height < checkpointHeight || height > bestHeight ? bytes32(0) : main[height]; }
    function heightOf(bytes32 hash) external view returns(uint64) { require(links[hash] != 0,"unknown header"); return _info(hash).height; }
    function chainWork(bytes32 hash) public view returns(uint256) { if(links[hash] == 0)return 0;Info memory n=_info(hash);return _work(n,epochs[n.epoch]); }
    function timestampOf(bytes32 hash) external view returns(uint32) { return _info(hash).time; }
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
        // Internal callers validated an 80-byte header and use offsets 68 or 72.
        assembly ("memory-safe") {
            let v := mload(add(add(h,32),at))
            at := or(or(byte(0,v),shl(8,byte(1,v))),or(shl(16,byte(2,v)),shl(24,byte(3,v))))
        }
        return uint32(at);
    }
    function reverse(bytes32 value) public pure returns(bytes32) {
        uint256 v = uint256(value);
        // Fixed byte-lane swaps, tested against the reference byte loop.
        v = ((v & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff) << 8) | ((v >> 8) & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff);
        v = ((v & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff) << 16) | ((v >> 16) & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff);
        v = ((v & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff) << 32) | ((v >> 32) & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff);
        v = ((v & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff) << 64) | ((v >> 64) & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff);
        return bytes32((v << 128) | (v >> 128));
    }
}
