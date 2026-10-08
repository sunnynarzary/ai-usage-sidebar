const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('webview paints allowlisted detail, plan, model and note as text', () => {
  const elements = new Map(); let onMessage;
  class Element {
    constructor() { this.children=[]; this.classList={toggle:()=>{}}; this.textContent=''; this.style={}; this.attrs={}; }
    setAttribute(k,v) { this.attrs[k]=v; }
    addEventListener() {}
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children=items; }
  }
  const document={getElementById:id=>{if (!elements.has(id)) elements.set(id,new Element());return elements.get(id)},createElement:()=>new Element()};
  const window={addEventListener:(event,handler)=>{if(event==='message') onMessage=handler}};
  const script=fs.readFileSync(path.join(__dirname,'..','media','dashboard.js'),'utf8');
  vm.runInNewContext(script,{document,window,acquireVsCodeApi:()=>({postMessage:()=>{}}),setInterval:()=>{}});
  onMessage({data:{type:'state',claude:{visible:true,title:'Claude',state:'ready',plan:'',updatedAt:Date.now(),notes:['Extra usage limit reached.'],rows:[{label:'Claude Sonnet 4.5 (7 day)',used:25,detail:'$12.34 of $30.00 this month'}]},codex:{visible:true,title:'Codex',state:'ready',plan:'Plus',rows:[]},cursor:{visible:false}}});
  const row=elements.get('claude-usage').children[0];
  assert.equal(row.children[0].children[0].textContent,'Claude Sonnet 4.5 (7 day)');
  assert.equal(row.children[2].textContent,'$12.34 of $30.00 this month');
  assert.match(elements.get('claude-note').textContent,/Extra usage limit reached/);
  assert.equal(elements.get('codex-plan').textContent,'Plus');
});

test('progress bars turn warning at 80% and error at 100%', () => {
  const elements = new Map(); let onMessage;
  class Element {
    constructor() { this.children=[]; this.classList={toggle:()=>{}}; this.textContent=''; this.style={}; this.attrs={}; }
    setAttribute(k,v) { this.attrs[k]=v; }
    addEventListener() {}
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children=items; }
  }
  const document={getElementById:id=>{if (!elements.has(id)) elements.set(id,new Element());return elements.get(id)},createElement:()=>new Element()};
  const window={addEventListener:(event,handler)=>{if(event==='message') onMessage=handler}};
  const script=fs.readFileSync(path.join(__dirname,'..','media','dashboard.js'),'utf8');
  vm.runInNewContext(script,{document,window,acquireVsCodeApi:()=>({postMessage:()=>{}}),setInterval:()=>{}});
  onMessage({data:{type:'state',claude:{visible:true,title:'Claude',state:'ready',plan:'',updatedAt:Date.now(),notes:[],rows:[{label:'Session (5hr)',used:79},{label:'Weekly (7 day)',used:80},{label:'Model usage',used:95},{label:'Extra usage',used:100}]},codex:{visible:false},cursor:{visible:false}}});
  const bars=elements.get('claude-usage').children.map(row=>row.children.find(c=>c.className==='progress-track').children[0]);
  assert.deepEqual(bars.map(b=>b.className),['progress-bar','progress-bar high','progress-bar high','progress-bar full']);
  assert.deepEqual(bars.map(b=>b.style.width),['79%','80%','95%','100%']);
  const css=fs.readFileSync(path.join(__dirname,'..','media','dashboard.css'),'utf8');
  assert.match(css,/\.progress-bar\.high\s*\{[^}]*editorWarning-foreground/);
  assert.match(css,/\.progress-bar\.full\s*\{[^}]*errorForeground/);
});

test('reset times choose units from unrounded duration at minute, hour, and day boundaries', () => {
  const elements = new Map(); let onMessage;
  class Element {
    constructor() { this.children=[]; this.classList={toggle:()=>{}}; this.textContent=''; this.style={}; this.attrs={}; }
    setAttribute(k,v) { this.attrs[k]=v; }
    addEventListener() {}
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children=items; }
  }
  const document={getElementById:id=>{if (!elements.has(id)) elements.set(id,new Element());return elements.get(id)},createElement:()=>new Element()};
  const window={addEventListener:(event,handler)=>{if(event==='message') onMessage=handler}};
  const now=Date.UTC(2026,9,8,12,0,0); const RealDate=Date;
  const FakeDate=class extends RealDate { static now() { return now; } };
  const script=fs.readFileSync(path.join(__dirname,'..','media','dashboard.js'),'utf8');
  vm.runInNewContext(script,{document,window,Date:FakeDate,Math,String,acquireVsCodeApi:()=>({postMessage:()=>{}}),setInterval:()=>{}});
  const at=sec=>(now/1000)+sec;
  onMessage({data:{type:'state',claude:{visible:true,title:'Claude',state:'ready',plan:'',updatedAt:now,notes:[],rows:[
    {label:'a',used:1,resetsAt:at(30)},{label:'b',used:1,resetsAt:at(59)},{label:'c',used:1,resetsAt:at(60)},
    {label:'d',used:1,resetsAt:at(61)},{label:'e',used:1,resetsAt:at(45*60)},
    {label:'f',used:1,resetsAt:at(59*60)},{label:'g',used:1,resetsAt:at(59*60+1)},
    {label:'h',used:1,resetsAt:at(60*60)},{label:'i',used:1,resetsAt:at(60*60+1)},
    {label:'j',used:1,resetsAt:at(3*3600+57*60)},{label:'k',used:1,resetsAt:at(18*3600+27*60)},
    {label:'l',used:1,resetsAt:at(23*3600+59*60)},{label:'m',used:1,resetsAt:at(23*3600+59*60+1)},
    {label:'n',used:1,resetsAt:at(24*3600)},{label:'o',used:1,resetsAt:at(24*3600+1)},
    {label:'p',used:1,resetsAt:at(141*3600+34*60)},{label:'q',used:1,resetsAt:at(573*3600+4*60)}]},codex:{visible:false},cursor:{visible:false}}});
  const resets=elements.get('claude-usage').children.map(row=>row.children.filter(c=>c.className==='reset-time').map(c=>c.textContent).pop());
  assert.deepEqual(resets,[
    'Resets in less than 1m','Resets in less than 1m','Resets in 1m','Resets in 2m','Resets in 45m',
    'Resets in 59m','Resets in 59m','Resets in 1h 0m','Resets in 1h 1m',
    'Resets in 3h 57m','Resets in 18h 27m','Resets in 23h 59m','Resets in 23h 59m',
    'Resets in 1d 0h','Resets in 1d 0h','Resets in 5d 21h','Resets in 23d 21h'
  ]);
  assert.equal(resets.some(reset => /(?:\b60m|\b24h)/.test(reset)),false);
});
