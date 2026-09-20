// Scenario calculator, not a gas-price/asset-price oracle. All prices below are hypothetical inputs.
const gasPerHeight=Number(process.env.GAS_PER_HEIGHT||300000);
if(!Number.isFinite(gasPerHeight)||gasPerHeight<=0)throw Error('positive GAS_PER_HEIGHT required');
const heightsPerDay=144,feeRate=0.0005,bountyDivisor=10000;
const scenarios=[
 {chain:'BSC',gasPriceGwei:0.1,native:'BNB',assumedNativeUsd:600},
 {chain:'Ethereum L1',gasPriceGwei:1,native:'ETH',assumedNativeUsd:3000},
 {chain:'Ethereum L1',gasPriceGwei:5,native:'ETH',assumedNativeUsd:3000}
].map(s=>{
 const costPerHeight=gasPerHeight*s.gasPriceGwei*1e-9,costPerDay=costPerHeight*heightsPerDay;
 return {...s,costPerHeight,costPerDay,costUsdPerDay:costPerDay*s.assumedNativeUsd,
 minimumReserveForNextHeight:costPerHeight*bountyDivisor,
 breakEvenFeeBearingVolumePerDay:costPerDay/feeRate,
 breakEvenFeeBearingUsdVolumePerDay:costPerDay*s.assumedNativeUsd/feeRate};
});
console.log(JSON.stringify({assumptions:{gasPerHeight,heightsPerDay,feeRate,bountyDivisor,
 priceInputs:'hypothetical, not live quotes',
 gasBudget:'300k default after T2b: routine one-height operation with allowance for transaction, routing and amortized claims; not a hard cap',
 zeroRevenueHalfLifeDays:Math.log(0.5)/Math.log(1-1/bountyDivisor)/heightsPerDay},scenarios},null,2));
