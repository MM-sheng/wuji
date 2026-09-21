import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {terminalRelease,registerRelease} from './register-terminal-deployment.mjs';
const base=JSON.parse(fs.readFileSync(new URL('../contracts/deployments/sepolia-weth-v3.json',import.meta.url)));
const candidate={...base,version:'bitcoin-sepolia-v4',frozenExitDelay:144};
const html='  const RELEASES={"sepolia":{"version":"keep existing"}};\n<select id="deploymentSelect">';
test('register v4 explicitly, preserve existing releases and refuse accidental overwrite',()=>{
 const result=registerRelease(html,candidate);assert.match(result,/keep existing/);assert.match(result,/"frozenExit":true/);assert.match(result,/option value="sepoliaV4"/);
 assert.throws(()=>registerRelease(result,candidate),/already registered/);
});
test('reject legacy, unconfirmed, wrong network/delay or credential-bearing endpoints',()=>{
 for(const override of [{version:base.version},{status:'pending'},{chainId:1},{frozenExitDelay:1},{rpc:'https://user:password@host'},{WujiIndex:'0x'+'0'.repeat(40)}])assert.throws(()=>terminalRelease({...candidate,...override}));
});
