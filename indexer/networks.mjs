// Explicit network metadata: never infer an explorer or wallet network from a default.
export const NETWORKS = Object.freeze({
  56: {name:'BNB Smart Chain', symbol:'BNB', rpc:'https://bsc-rpc.publicnode.com', explorer:'https://bscscan.com'},
  97: {name:'BNB Smart Chain Testnet', symbol:'tBNB', rpc:'https://bsc-testnet-rpc.publicnode.com', explorer:'https://testnet.bscscan.com'},
  11155111: {name:'Ethereum Sepolia', symbol:'ETH', rpc:'https://ethereum-sepolia-rpc.publicnode.com', explorer:'https://sepolia.etherscan.io'},
});
export function network(chainId) {
  const value=NETWORKS[chainId];
  if(!value)throw Error(`Unsupported chain ${chainId}`);
  return {chainId:Number(chainId),...value};
}
export function assertChain(actual,expected) {
  if(BigInt(actual)!==BigInt(expected))throw Error(`RPC chain mismatch: expected ${expected}, received ${BigInt(actual)}`);
}
