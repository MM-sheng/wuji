// Recompile fresh Foundry Standard JSON with the release's literal remapping contexts.
// Foundry adds an absolute context for relative scoped remappings; freeze that metadata
// input BEFORE compilation, never edit or strip the resulting bytecode/metadata.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const [root,out]=process.argv.slice(2);
const candidates=[process.env.SOLC,path.join(os.homedir(),'.svm/0.8.28/solc-0.8.28'),path.join(os.homedir(),'Library/Application Support/svm/0.8.28/solc-0.8.28')].filter(Boolean);
const solc=candidates.find(p=>fs.existsSync(p));assert.ok(solc,'Set SOLC to the native solc 0.8.28 installed by Foundry');
assert.match(execFileSync(solc,['--version'],{encoding:'utf8'}),/Version: 0\.8\.28\+commit\.7893614a\b/,'wrong solc version');
const buildFiles=fs.readdirSync(path.join(out,'build-info')).filter(f=>f.endsWith('.json'));assert.equal(buildFiles.length,1,'expected one fresh compiler input');
const build=JSON.parse(fs.readFileSync(path.join(out,'build-info',buildFiles[0])));
assert.equal(build.solcVersion,'0.8.28');
const input={language:build.input.language,sources:build.input.sources,settings:build.input.settings};
input.settings.remappings=JSON.parse(fs.readFileSync(path.join(root,'contracts/remappings-v3.json')));
assert.deepEqual(input.settings.optimizer,{enabled:true,runs:200});assert.equal(input.settings.evmVersion,'prague');assert.equal(input.settings.viaIR,false);
assert.deepEqual(input.settings.metadata,{useLiteralContent:false,bytecodeHash:'ipfs',appendCBOR:true});
input.settings.outputSelection={'*':{'*':['abi','evm.bytecode','evm.deployedBytecode','metadata']}};
const output=JSON.parse(execFileSync(solc,['--standard-json'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:128*1024*1024}));
const errors=(output.errors||[]).filter(e=>e.severity==='error');assert.equal(errors.length,0,errors.map(e=>e.formattedMessage).join('\n'));
for(const [file,contracts] of Object.entries(output.contracts))for(const [name,c] of Object.entries(contracts)){
 const dir=path.join(out,path.basename(file));fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify({abi:c.abi,bytecode:c.evm.bytecode,deployedBytecode:c.evm.deployedBytecode,metadata:JSON.parse(c.metadata)}));
}
console.error('Recompiled pinned Standard JSON; immutable references and metadata are unmodified compiler outputs.');
