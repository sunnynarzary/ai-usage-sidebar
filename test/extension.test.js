const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const settings = { 'cards.claude':'auto','cards.codex':'auto','cards.cursor':'auto','cursor.source':'ide' };
const prompts = [];
const vscode = {
  workspace: { getConfiguration:()=>({get:(key,def)=>settings[key]??def,update:async(key,value)=>{settings[key]=value}}) },
  window: { showInformationMessage:async(text)=>{prompts.push(text);return 'Enable'},showQuickPick:async()=>undefined },
  ConfigurationTarget:{Global:1}
};
const original = Module._load;
Module._load = function(request,parent,isMain) { if(request==='vscode') return vscode; return original.apply(this,arguments); };
const { Dashboard, consentText } = require('../src/extension');
Module._load = original;
function context() { const map = new Map(), updates = []; return {map,updates,globalState:{get:(k,d)=>map.has(k)?map.get(k):d,update:async(k,v)=>{updates.push([k,v]);map.set(k,v)}},subscriptions:[]}; }

test('never causes no provider read even with stored consent; always alone does not grant consent', async()=>{
  let reads=0;
  try {
    const c=context(); await c.globalState.update('consent.claude',true);
    const d=new Dashboard(c,{claude:async()=>{reads++;return {rows:[]}},codex:async()=>{reads++;return {rows:[]}},cursor:async()=>{reads++;return {rows:[]}}}); const messages=[]; d.view={visible:true,webview:{postMessage:m=>messages.push(m)}};
    settings['cards.claude']='never'; d.tick(true); await new Promise(r=>setImmediate(r));
    assert.equal(reads,0);
    settings['cards.claude']='always'; await d.disable('claude'); d.tick(true);
    assert.equal(reads,0); assert.equal(d.data.claude.state,'notEnabled');
  } finally { settings['cards.claude']='auto'; }
});

test('switching Cursor source revokes prior consent and prompts for exact new location before read', async()=>{
  const c=context(); await c.globalState.update('consent.cursor.ide',true); await c.globalState.update('consent.cursor.cursor-agent',true);
  const d=new Dashboard(c); d.view={visible:false,webview:{postMessage:()=>{}}};
  settings['cursor.source']='cursor-agent';
  await d.settingsChanged({affectsConfiguration:key=>key==='aiUsage'});
  assert.equal(prompts.length,1);
  assert.match(prompts[0],/cursor-access-token macOS Keychain item/);
  assert.match(prompts[0],/POST https:\/\/api2.cursor.sh\/aiserver.v1.DashboardService\/GetCurrentPeriodUsage/);
  assert.equal(c.globalState.get('consent.cursor.cursor-agent'),true);
  settings['cursor.source']='ide';
  await d.settingsChanged({affectsConfiguration:key=>key==='aiUsage'});
  assert.match(prompts[1],/state.vscdb, key cursorAuth\/accessToken/);
  assert.match(prompts[1],/%APPDATA%/);
  assert.equal(c.globalState.get('consent.cursor.ide'),true);
});

test('postMessage never contains a provider error canary', async()=>{
  const canary='CANARY_SECRET_TOKEN_ABC123';
  const c=context(); await c.globalState.update('consent.claude',true);
  const d=new Dashboard(c,{claude:async()=>{throw new Error(canary)},codex:async()=>({rows:[]}),cursor:async()=>({rows:[]})});
  const messages=[]; d.view={visible:true,webview:{postMessage:m=>messages.push(m)}};
  await d.refresh('claude');
  assert.equal(JSON.stringify(messages).includes(canary),false);
  assert.equal(messages.at(-1).claude.state,'error');
});

test('provider payload canary is excluded from webview, storage, and console', async()=>{
  const canary='CANARY_SECRET_TOKEN_ABC123';
  const c=context(); await c.globalState.update('consent.claude',true);
  const d=new Dashboard(c,{claude:async()=>({rows:[{label:canary,used:44,detail:canary},{label:'Session (5hr)',used:17}],plan:canary,notes:[canary]}),codex:async()=>({}),cursor:async()=>({})});
  const messages=[]; d.view={visible:true,webview:{postMessage:m=>messages.push(m)}};
  const logged=[]; const oldLog=console.log,oldError=console.error,oldWarn=console.warn;
  console.log=(...a)=>logged.push(a);console.error=(...a)=>logged.push(a);console.warn=(...a)=>logged.push(a);
  try { await d.refresh('claude'); }
  finally { console.log=oldLog;console.error=oldError;console.warn=oldWarn; }
  assert.equal(JSON.stringify(messages).includes(canary),false);
  assert.equal(JSON.stringify(logged).includes(canary),false);
  assert.equal(JSON.stringify(c.updates).includes(canary),false);
  assert.equal(messages.at(-1).claude.rows.length,1);
});

test('inactive Cursor source change revokes old consent before any read', async()=>{
  const c=context(); c.map.set('cursor.selectedSource','ide'); c.map.set('consent.cursor.ide',true); c.map.set('consent.cursor.cursor-agent',true);
  settings['cursor.source']='cursor-agent';
  let reads=0;
  const d=new Dashboard(c,{claude:async()=>({}),codex:async()=>({}),cursor:async()=>{reads++;return {rows:[]}}});
  d.view={visible:true,webview:{postMessage:()=>{}}};
  d.tick(true);
  await d.sourceReady;
  d.tick(true);
  assert.equal(reads,0);
  assert.equal(c.map.get('consent.cursor.cursor-agent'),false);
  assert.equal(c.map.get('cursor.selectedSource'),'cursor-agent');
  settings['cursor.source']='ide';
});

test('source switch aborts the old Cursor read and refreshes the new source', async()=>{
  const c=context(); c.map.set('cursor.selectedSource','ide'); c.map.set('consent.cursor.ide',true); c.map.set('consent.cursor.cursor-agent',true);
  settings['cursor.source']='ide';
  let oldAborted=false, newReads=0;
  const d=new Dashboard(c,{claude:async()=>({}),codex:async()=>({}),cursor:(selected,{signal})=>selected==='ide' ? new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{oldAborted=true;reject(Error('aborted'))},{once:true})) : (newReads++,Promise.resolve({rows:[]}))});
  await d.sourceReady;
  d.view={visible:true,webview:{postMessage:()=>{}}};
  const old=d.refresh('cursor');
  settings['cursor.source']='cursor-agent';
  await d.settingsChanged({affectsConfiguration:key=>key==='aiUsage'});
  await old;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(oldAborted,true);
  assert.ok(newReads>=1);
  assert.equal(d.data.cursor.state,'ready');
  settings['cursor.source']='ide';
});

test('canaries from every provider and error stay out of storage and file write APIs', async()=>{
  const canary='CANARY_SECRET_TOKEN_ABC123';
  const c=context(); for (const id of ['claude','codex','cursor']) c.map.set(`consent.${id==='cursor'?'cursor.ide':id}`,true);
  c.map.set('cursor.selectedSource','ide');
  const writes=[]; const originalWrite=fs.writeFileSync, originalAppend=fs.appendFileSync, originalStream=fs.createWriteStream;
  const promiseWrite=fs.promises.writeFile, promiseAppend=fs.promises.appendFile;
  fs.writeFileSync=(...args)=>{writes.push(args);throw Error('unexpected write')};
  fs.appendFileSync=(...args)=>{writes.push(args);throw Error('unexpected write')};
  fs.createWriteStream=(...args)=>{writes.push(args);throw Error('unexpected write')};
  fs.promises.writeFile=async(...args)=>{writes.push(args);throw Error('unexpected write')};
  fs.promises.appendFile=async(...args)=>{writes.push(args);throw Error('unexpected write')};
  try {
    const d=new Dashboard(c,Object.fromEntries(['claude','codex','cursor'].map(id=>[id,async()=>({rows:[{label:canary,used:12,detail:canary}],plan:canary,notes:[canary]})])));
    await d.sourceReady;
    const messages=[]; d.view={visible:false,webview:{postMessage:m=>messages.push(m)}};
    for (const id of ['claude','codex','cursor']) await d.refresh(id);
    d.readers=Object.fromEntries(['claude','codex','cursor'].map(id=>[id,async()=>{throw Error(canary)}]));
    for (const id of ['claude','codex','cursor']) await d.refresh(id);
    assert.equal(JSON.stringify([c.updates,messages,writes]).includes(canary),false);
    assert.equal(writes.length,0);
  } finally { fs.writeFileSync=originalWrite; fs.appendFileSync=originalAppend; fs.createWriteStream=originalStream; fs.promises.writeFile=promiseWrite; fs.promises.appendFile=promiseAppend; }
});

test('both Cursor consent prompts disclose every fetched route', async()=>{
  const core=require('../src/core'); const urls=[];
  await core.readCursor('cursor-agent',{platform:'darwin',keychain:async()=> 'fixture-token',fetch:async(url)=>{urls.push(url);return {ok:true,json:async()=>({})}}});
  const readme=fs.readFileSync(require('node:path').join(__dirname,'..','README.md'),'utf8');
  for (const selected of ['ide','cursor-agent']) {
    settings['cursor.source']=selected;
    const disclosed=[...consentText('cursor').matchAll(/POST (https:\/\/api2\.cursor\.sh\/[^\s.]+(?:\.[^\s.]+)*\/[^\s.]+)/g)].map(match=>match[1].replace(/\.$/,''));
    assert.deepEqual(new Set(disclosed),new Set(urls));
    for (const url of urls) assert.ok(readme.includes(`POST ${url}`));
  }
  assert.equal(new Set(urls).size,2);
  settings['cursor.source']='ide';
});

test('Manage tools does not offer Enable for cards configured never', async()=>{
  const old=vscode.window.showQuickPick;
  let items;
  settings['cards.claude']='never';
  vscode.window.showQuickPick=async choices=>{items=choices;return undefined};
  try {
    const d=new Dashboard(context()); await d.sourceReady; await d.manage();
    assert.equal(items.some(item=>item.id==='claude'),false);
    assert.equal(items.some(item=>item.id==='codex' && item.label.startsWith('Enable')),true);
  } finally { settings['cards.claude']='auto'; vscode.window.showQuickPick=old; }
});
