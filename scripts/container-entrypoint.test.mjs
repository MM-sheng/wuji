import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {containerEnv} from './container-entrypoint.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../contracts/deployments/sepolia-weth-v3.json',import.meta.url)));
test('container binds protocol addresses and chain to a confirmed manifest, allows independent RPC',()=>{
 const env=containerEnv(manifest,{CONTRACT:'wrong',CHAIN_ID:'1',RPC:'http://own-node'},'indexer');
 assert.equal(env.CONTRACT,manifest.WujiIndex);assert.equal(env.CHAIN_ID,'11155111');assert.equal(env.RPC,'http://own-node');assert.equal(env.SOURCE,'bitcoin');assert.equal(env.RELAY_TIMESTAMPS,'1');
});
test('keeper needs named encrypted account and absolute password path; chain-specific fees',()=>{
 const credentials={KEYSTORE_ACCOUNT:'test-operator',PASSWORD_FILE:'/run/secrets/password'};
 assert.equal(containerEnv(manifest,credentials,'keeper').KEEPER_GAS_PRICE,'');
 assert.equal(containerEnv({...manifest,chainId:97},credentials,'keeper').KEEPER_GAS_PRICE,'0.1gwei');
 assert.throws(()=>containerEnv(manifest,{},'keeper'),/KEYSTORE_ACCOUNT/);
 assert.throws(()=>containerEnv(manifest,{...credentials,KEYSTORE_ACCOUNT:'../escape'},'keeper'));
 assert.throws(()=>containerEnv(manifest,{...credentials,PASSWORD_FILE:'password'},'keeper'));
});
test('reject mainnet, unconfirmed or historical deployments',()=>{
 for(const override of [{chainId:1},{status:'pending'},{version:'bitcoin-rewards-v1'}])assert.throws(()=>containerEnv({...manifest,...override},{},'indexer'));
});

test('exit automation is bound to the explicit v4 manifest, never inherited by v3',()=>{
 assert.equal(containerEnv(manifest,{FROZEN_EXIT:'1'},'indexer').FROZEN_EXIT,'0');
 assert.equal(containerEnv({...manifest,version:'bitcoin-sepolia-v4'}, {}, 'indexer').FROZEN_EXIT,'1');
});

test('zk-watcher role: wiring from a T12 manifest, alert-only without a key', async () => {
 const {zkWatcherEnv}=await import('./container-entrypoint.mjs');
 const fs=await import('node:fs');
 const zk=JSON.parse(fs.readFileSync(new URL('../contracts/deployments/sepolia-zk-t12-v2.json',import.meta.url)));
 const env=zkWatcherEnv(zk,{});
 assert.equal(env.ZK_INDEX,zk.ZkWujiIndex.toLowerCase());assert.equal(env.CHAIN_ID,'11155111');
 assert.equal(env.WATCH_DRY_RUN,'1','no key: never sends');assert.equal(env.WATCH_SOURCES,'p2p,http');assert.ok(env.RPC);
 const acting=zkWatcherEnv(zk,{KEYSTORE_ACCOUNT:'watcher-two',PASSWORD_FILE:'/run/secrets/p'});
 assert.equal(acting.WATCH_DRY_RUN,undefined);
 assert.throws(()=>zkWatcherEnv(zk,{KEYSTORE_ACCOUNT:'bad name',PASSWORD_FILE:'/p'}),/KEYSTORE_ACCOUNT/);
 assert.throws(()=>zkWatcherEnv({...zk,version:'bitcoin-sepolia-v4'},{}),/T12 ZK manifest/);
});
