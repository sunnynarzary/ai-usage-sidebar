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
