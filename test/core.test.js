const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const core = require('../src/core');

test('visibility and public error taxonomy', () => {
  for (const state of core.STATES) {
    assert.equal(core.visible('never', state), false);
    assert.equal(core.visible('always', state), true);
    assert.equal(core.visible('auto', state), state !== 'signedOut');
  }
  const canary = 'CANARY_SECRET_TOKEN_ABC123';
  assert.equal(JSON.stringify(core.publicFailure(new Error(canary))).includes(canary), false);
  assert.equal(core.publicFailure(new core.ProviderError('signedOut')).state, 'signedOut');
});

test('Claude discovery prefers later expiry and distinguishes errors', async () => {
  const fresh = { accessToken: 'fixture-fresh', expiresAt: Date.now() + 100000 };
  const stale = { accessToken: 'fixture-stale', expiresAt: Date.now() - 100000 };
  const token = await core.claudeToken({ platform:'darwin', home:'/fixture', env:{}, keychain: async()=>JSON.stringify({claudeAiOauth:fresh}), fileCredential: async()=>({claudeAiOauth:stale}) });
  assert.equal(token, 'fixture-fresh');
  await assert.rejects(core.claudeToken({platform:'linux',home:'/fixture',env:{},fileCredential:async()=>{throw new core.ProviderError('signedOut')}}), e=>e.state==='signedOut');
  await assert.rejects(core.claudeToken({platform:'darwin',home:'/fixture',env:{},keychain:async()=>{throw new core.ProviderError('error')},fileCredential:async()=>{throw new core.ProviderError('signedOut')}}), e=>e.state==='error');
  await assert.rejects(core.claudeToken({platform:'win32',home:'C:\\Fixture',env:{},fileCredential:async()=>({claudeAiOauth:stale})}), e=>e.state==='expired');
  assert.equal(core.claudePaths({CLAUDE_CONFIG_DIR:'C:\\Other'},'C:\\Users\\Tester','win32')[0], 'C:\\Other\\.credentials.json');
});

test('Cursor read-only SQLite sees token committed only in live WAL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ai-usage-wal-'));
  const file = path.join(dir,'state.vscdb');
  let writer;
  try {
    writer = new DatabaseSync(file);
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
    writer.prepare('INSERT INTO ItemTable (key,value) VALUES (?,?)').run('cursorAuth/accessToken','fixture-wal-only');
    assert.ok(fs.statSync(`${file}-wal`).size > 0);
    assert.equal(await core.cursorIdeToken({file}), 'fixture-wal-only');
    await assert.rejects(core.cursorIdeToken({file,sqlite:{}}), e=>e.state==='unavailable');
  } finally { writer?.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('Cursor source separation and Windows cursor-agent unavailable', async () => {
  await assert.rejects(core.cursorToken('cursor-agent',{platform:'win32',keychain:async()=>{throw Error('must not read')}}), e=>e.state==='unavailable');
  assert.equal(core.cursorDbPath('win32',{APPDATA:'C:\\Users\\Test User\\AppData\\Roaming'},'C:\\Users\\Test User'), 'C:\\Users\\Test User\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb');
});

test('vendor requests use fixed HTTPS origin, deny redirects, and scrub response strings', async () => {
  const calls=[];
  const canary='CANARY_SECRET_TOKEN_ABC123';
  await core.readClaude({platform:'linux',home:'/fixture',env:{},
    fileCredential:async()=>({claudeAiOauth:{accessToken:canary,expiresAt:Date.now()+100000}}),
    fetch:async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>({limits:[{kind:canary,scope:{model:{display_name:canary}},percent:23}]})};}
  });
  assert.equal(calls[0][0], 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0][1].redirect, 'error');
  const result=await core.readCursor('cursor-agent',{platform:'darwin',keychain:async()=>canary,fetch:async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>({planUsage:{totalPercentUsed:11},displayMessage:canary})}}});
  assert.equal(JSON.stringify(result).includes(canary),false);
  assert.equal(calls[1][0], 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage');
  assert.equal(calls[1][1].redirect, 'error');
  await assert.rejects(core.vendorFetch(core.ORIGINS.claude,'https://evil.test/',{},async()=>{}),e=>e.state==='unavailable');
});

test('Codex Windows resolution bypasses cmd shim and killTree uses taskkill', () => {
  const dir='C:\\Users\\Test User\\AppData\\Roaming\\npm';
  for (const [arch,pkg,target] of [['x64','codex-win32-x64','x86_64-pc-windows-msvc'],['arm64','codex-win32-arm64','aarch64-pc-windows-msvc']]) {
    const binary=path.win32.join(dir,'node_modules','@openai','codex','node_modules','@openai',pkg,'vendor',target,'bin','codex.exe');
    const exists=p=>[path.win32.join(dir,'codex.cmd'),binary].includes(p);
    const found=core.resolveCodex('win32',{PATH:dir},exists,'C:\\Users\\Test User',arch,'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(found,{command:binary,args:[]});
    const sibling=path.win32.join(dir,'node_modules','@openai',pkg,'vendor',target,'bin','codex.exe');
    const foundSibling=core.resolveCodex('win32',{PATH:dir},p=>[path.win32.join(dir,'codex.cmd'),sibling].includes(p),'C:\\Users\\Test User',arch,'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(foundSibling.command,sibling);
  }
  const js=path.win32.join(dir,'node_modules','@openai','codex','bin','codex.js');
  const node='C:\\Program Files\\nodejs\\node.exe';
  assert.deepEqual(core.resolveCodex('win32',{PATH:dir},p=>[path.win32.join(dir,'codex.cmd'),js,node].includes(p),'C:\\Users\\Test User','x64',node),{command:node,args:[js]});
  let args;
  core.killTree({pid:321},'win32',(cmd,a)=>{assert.equal(cmd,'taskkill');args=a});
  assert.deepEqual(args,['/T','/F','/PID','321']);
});

test('Codex app-server error text never escapes to public state', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const canary = 'CANARY_SECRET_TOKEN_ABC123';
  const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  child.stdin.on('data', chunk => {
    const msg = JSON.parse(String(chunk));
    if (msg.method === 'initialize') child.stdout.write(JSON.stringify({id:msg.id,result:{}})+'\n');
    if (msg.method === 'account/rateLimits/read') child.stdout.write(JSON.stringify({id:msg.id,error:{message:canary,code:'INTERNAL_ERROR'}})+'\n');
  });
  await assert.rejects(core.readCodex({ resolveCodex:()=>({command:'/fixture/codex',args:[]}),spawn:()=>child,platform:'darwin' }), e => {
    const publicResult = core.publicFailure(e);
    assert.equal(JSON.stringify(publicResult).includes(canary),false);
    return publicResult.state === 'error';
  });
});

test('aborting an in-flight Codex read kills its process tree', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const controller = new AbortController();
  const child = new EventEmitter(); child.pid=987; child.stdout=new PassThrough(); child.stdin=new PassThrough();
  let killed;
  const promise=core.readCodex({signal:controller.signal,platform:'win32',resolveCodex:()=>({command:'C:\\Program Files\\codex.exe',args:[]}),spawn:()=>child,execFile:(cmd,args,opts,cb)=>{killed={cmd,args};cb()}});
  controller.abort();
  await assert.rejects(promise,e=>e.state==='error');
  assert.deepEqual(killed,{cmd:'taskkill',args:['/T','/F','/PID','987']});
});

test('Codex ignores stderr and handles an early stdin pipe error', async () => {
  const { EventEmitter }=require('node:events'); const { PassThrough }=require('node:stream');
  const child=new EventEmitter(); child.pid=2; child.stdout=new PassThrough(); child.stdin=new PassThrough(); child.kill=()=>{};
  let options;
  const pending=core.readCodex({resolveCodex:()=>({command:'/fixture/codex',args:[]}),spawn:(_command,_args,opts)=>{options=opts;return child},platform:'darwin'});
  assert.deepEqual(options.stdio,['pipe','pipe','ignore']);
  child.stdin.emit('error',Object.assign(Error('broken pipe'),{code:'EPIPE'}));
  await assert.rejects(pending,e=>e.state==='error');
});

test('custom provider errors cannot pass token text to the webview', () => {
  const canary='CANARY_SECRET_TOKEN_ABC123';
  assert.equal(JSON.stringify(core.publicFailure(new core.ProviderError('error',canary))).includes(canary),false);
});

test('Claude model, spend, Cursor spend, and Codex plan survive public projection', () => {
  const claude=core.publicReady(core.normalizeClaude({limits:[{kind:'weekly_model',scope:{model:{display_name:'Claude Sonnet 4.5'}},percent:31}],spend:{enabled:true,percent:40,used:{amount_minor:1234,exponent:2},limit:{amount_minor:3000,exponent:2}}}));
  assert.equal(claude.rows[0].label,'Claude Sonnet 4.5 (7 day)');
  assert.equal(claude.rows[1].detail,'$12.34 of $30.00 this month');
  const cursor=core.publicReady(core.normalizeCursor({planUsage:{totalPercentUsed:50,includedSpend:1200,limit:2000,bonusSpend:300},spendLimitUsage:{limitType:'team',pooledUsed:500,pooledLimit:1000,individualUsed:100}}));
  assert.equal(cursor.rows[0].detail,'$12.00 of $20.00 · +$3.00 bonus');
  assert.equal(cursor.rows[1].detail,'$5.00 of $10.00 · you $1.00');
  const codex=core.publicReady(core.normalizeCodex({rateLimits:{planType:'self_serve_plus',primary:{usedPercent:10}}}));
  assert.equal(codex.plan,'Plus');
  const canary='CANARY_SECRET_TOKEN_ABC123';
  assert.equal(JSON.stringify(core.publicReady({rows:[{label:canary,used:1,detail:canary},{label:'Extra usage',detail:canary}],plan:canary})).includes(canary),false);
});

test('Claude model labels use original display name and surface fields without exposing vendor text', () => {
  const canary='CANARY_VENDOR_TEXT';
  const limits=[
    {kind:'session',scope:{model:{display_name:'Fable'}},percent:1},
    {kind:'weekly_all',scope:{model:{display_name:'Opus'}},percent:2},
    {kind:'weekly_model',scope:{model:{display_name:'Fable'}},percent:3},
    {kind:'weekly_model',scope:{model:{display_name:'Claude Opus 4.1'}},percent:4},
    {kind:'weekly_model',scope:{model:{display_name:'Sonnet'}},percent:5},
    {kind:'weekly_model',scope:{surface:'Claude Fable 4.5'},percent:6},
    {kind:'weekly_model',scope:{model:{display_name:canary},surface:'Opus'},percent:7},
    {kind:'weekly_model',scope:{model:{display_name:`Sonnet ${canary}`},surface:canary},percent:8}
  ];
  const result=core.publicReady(core.normalizeClaude({limits}));
  assert.deepEqual(result.rows.map(r=>r.label),[
    'Session (5hr)','Weekly (7 day)','Fable (7 day)','Claude Opus 4.1 (7 day)',
    'Sonnet (7 day)','Claude Fable 4.5 (7 day)','Opus (7 day)','Model usage'
  ]);
  assert.equal(JSON.stringify(result).includes(canary),false);
  const direct=core.publicReady({rows:[{label:`${canary} (7 day)`,used:10}]});
  assert.deepEqual(direct.rows,[]);
});

test('aborted Claude and Cursor reads make no later credential or vendor call', async () => {
  const controller=new AbortController(); let fetches=0;
  let release; const pending=new Promise(resolve=>{release=resolve});
  const claude=core.readClaude({platform:'linux',home:'/fixture',env:{},signal:controller.signal,fileCredential:async()=>{await pending;return {claudeAiOauth:{accessToken:'fixture'}}},fetch:async()=>{fetches++;return {ok:true,json:async()=>({})}}});
  controller.abort();release();
  await assert.rejects(claude,e=>e.state==='error'); assert.equal(fetches,0);
  const second=new AbortController(); let secondStarted; const started=new Promise(resolve=>{secondStarted=resolve});
  const cursor=core.readCursor('cursor-agent',{platform:'darwin',signal:second.signal,keychain:async()=> 'fixture',fetch:async(_url,opts)=>{fetches++;secondStarted();await new Promise(resolve=>opts.signal.addEventListener('abort',resolve,{once:true}));throw Error('aborted')}});
  await started;second.abort(); await assert.rejects(cursor); assert.equal(fetches,1);
});
