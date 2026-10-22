// Count complete cycles and individual pools independently. Never resubmit a transaction here.
export function keeperHealth(maxFailures){
 if(!Number.isInteger(maxFailures)||maxFailures<1)throw Error('ZK_MAX_FAILED_ROUNDS must be a positive integer');
 let roundFailures=0;const poolFailures=new Map();
 return {
  record(roundError,pools=[]){
   roundFailures=roundError?roundFailures+1:0;
   for(const {pool,transportFailed} of pools){
    poolFailures.set(pool,transportFailed?(poolFailures.get(pool)||0)+1:0);
   }
   if(roundFailures>=maxFailures)return `${roundFailures} index rounds failed in a row`;
   for(const [pool,count] of poolFailures)if(count>=maxFailures)return `${count} RPC maintenance failures in a row for ${pool}`;
   return null;
  },
 };
}

export async function keeperCycle({round,maintainAccounts,health,log}){
 let roundError=null;
 try{const r=await round();if(r.action==='wait')log(`waiting: ${r.available} headers past ${r.height}`);}
 catch(e){roundError=e;log('error:',e.message);}
 // Await every maintenance call before deciding to exit. No fire-and-forget sends at restart.
 const pools=await maintainAccounts();
 return health.record(roundError,pools);
}
