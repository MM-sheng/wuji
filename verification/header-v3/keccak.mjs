// Keccak-256 (Ethereum padding, not SHA3-256). Zero dependencies; verification only.
const MASK = (1n << 64n) - 1n;
const ROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const RC = [
  '0000000000000001','0000000000008082','800000000000808a','8000000080008000',
  '000000000000808b','0000000080000001','8000000080008081','8000000000008009',
  '000000000000008a','0000000000000088','0000000080008009','000000008000000a',
  '000000008000808b','800000000000008b','8000000000008089','8000000000008003',
  '8000000000008002','8000000000000080','000000000000800a','800000008000000a',
  '8000000080008081','8000000000008080','0000000080000001','8000000080008008',
].map(v => BigInt('0x' + v));
const rot = (v, n) => n ? ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK : v;
function permute(a) {
  for (const rc of RC) {
    const c = Array.from({length:5}, (_,x) => a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20]);
    for (let x=0; x<5; x++) {
      const d = c[(x+4)%5] ^ rot(c[(x+1)%5],1);
      for (let y=0; y<5; y++) a[x+5*y] ^= d;
    }
    const b = Array(25).fill(0n);
    for (let x=0; x<5; x++) for (let y=0; y<5; y++) b[y+5*((2*x+3*y)%5)] = rot(a[x+5*y],ROT[x+5*y]);
    for (let x=0; x<5; x++) for (let y=0; y<5; y++) a[x+5*y] = b[x+5*y] ^ ((~b[(x+1)%5+5*y]) & b[(x+2)%5+5*y]);
    a[0] ^= rc;
  }
}
export function keccak256(input) {
  const data = Buffer.from(input), padded = Buffer.alloc(Math.ceil((data.length+1)/136)*136);
  data.copy(padded); padded[data.length] = 1; padded[padded.length-1] |= 128;
  const a = Array(25).fill(0n);
  for (let offset=0; offset<padded.length; offset+=136) {
    for (let i=0; i<17; i++) a[i] ^= padded.readBigUInt64LE(offset+8*i);
    permute(a);
  }
  const result = Buffer.alloc(32);
  for (let i=0; i<4; i++) result.writeBigUInt64LE(a[i],8*i);
  return result;
}
