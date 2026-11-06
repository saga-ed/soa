import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base=process.env.VISHNU_TEST_URL??'http://127.0.0.1:11930';
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1708,height:1209}});
const page=await context.newPage();page.setDefaultTimeout(20000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const time=Date.now(), scope={environment:'synthetic',deployment:'slot-3',machine:'turing'};
let delay=0, replacement;
const prompts=[];
const makeChart=(kind='line')=>({id:crypto.randomUUID(),title:`IAM ${kind} verification`,system:'iam-api',kind,metric:kind==='scatter'?'cpu_memory':'latency',statistics:kind==='scatter'?['avg']:['avg','max'],time:{mode:'rolling',minutes:30},group:'service',population:'observations'});
await page.route('**/api/assistant/status',r=>r.fulfill({json:{enabled:true,model:'browser-test',message:'Test'}}));
await page.route('**/api/assistant/turn',async route=>{
 const input=route.request().postDataJSON();prompts.push(input.prompt);const chart=replacement??makeChart(input.prompt.includes('scatter')?'scatter':input.prompt.includes('histogram')?'histogram':'line');
 if(delay)await new Promise(r=>setTimeout(r,delay));
 await route.fulfill({contentType:'application/x-ndjson',body:[{type:'view',action:{type:'show_chart',chart},contextKey:input.contextKey},{type:'text',text:'Showing the requested test chart.\n'.repeat(60)},{type:'done',conversationId:crypto.randomUUID(),model:'browser-test'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
});
await page.route('**/api/charts/query',async route=>{
 const spec=route.request().postDataJSON();
 const result={status:'ready',source:'datadog',scope,observedAt:new Date(time).toISOString(),window:{from:time-1800000,to:time},intervalSeconds:60,message:'Browser test observations; not live measurements.',link:'',series:[{name:'Average',unit:'ms',points:[[time-120000,20],[time-60000,null],[time,30]]},{name:'Maximum',unit:'ms',points:[[time-120000,100],[time-60000,200],[time,300]]}],bins:[{name:'Duration',unit:'ms',buckets:[{from:0,to:100,count:4},{from:100,to:200,count:9}]}],pairs:[{instance:'a',time,cpu:.2,memory:100},{instance:'a',time:time-60000,cpu:.5,memory:150}]};
 if(spec.time.mode==='fixed')result.window={from:Date.parse(spec.time.from),to:Date.parse(spec.time.to)};
 await route.fulfill({json:result});
});
const ask=async text=>{await page.getByLabel('What would you like to investigate?').fill(text);await page.getByLabel('What would you like to investigate?').press('Enter');};
let savedName=`Chart browser verification ${Date.now()}`;
try {
 await page.goto(base);await page.getByRole('button',{name:'Ask Vishnu',exact:true}).click();
 const prompt=page.getByLabel('What would you like to investigate?');
 await prompt.fill('Show a line chart');
 await prompt.press('Alt+Enter');await prompt.pressSequentially('With latency details');
 assert.equal(await prompt.inputValue(),'Show a line chart\nWith latency details');assert.equal(prompts.length,0);
 await prompt.dispatchEvent('keydown',{key:'Enter',isComposing:true});assert.equal(prompts.length,0);
 await prompt.press('Enter');await page.locator('.chart-card').waitFor();
 assert.equal(prompts[0],'Show a line chart\nWith latency details');
 assert.equal(await page.getByRole('button',{name:'Investigate',exact:true}).count(),0);
await page.locator('.historical-plot svg').waitFor();
 // The average series has two isolated observations separated by a null bucket.
 // With hidden markers it produced a blank graph despite reporting READY.
 await page.waitForFunction(()=>document.querySelectorAll('.historical-plot svg path[fill="#65d6c6"]').length>=2);
 assert.equal(await page.locator('.workspace.mesh-minimized').count(),1);
 await ask('Add a histogram');await page.locator('.chart-card').nth(1).waitFor();
 await ask('Add a scatter');await page.locator('.chart-card').nth(2).waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('.historical-plot svg').length===3);
 for(const viewport of [{width:1708,height:1209},{width:1440,height:900}]) {
  await page.setViewportSize(viewport);
  await page.locator('main').evaluate(el=>el.scrollTop=400);
  await page.waitForFunction(()=>{const el=document.querySelector('#assistant-prompt');const r=el.getBoundingClientRect();return r.top>0 && r.bottom<innerHeight;});
  const visible=await prompt.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;});assert.ok(visible,'Composer stays visible while chart workspace scrolls');
  assert.ok(await page.locator('.assistant-history').evaluate(el=>el.scrollHeight>el.clientHeight),'Long answers scroll independently');
 }
 await page.locator('main').evaluate(el=>el.scrollTop=0);
 const fonts=await page.locator('.chart-workspace').evaluate(el=>[...el.querySelectorAll('button,label,input,select,strong,p')].map(e=>getComputedStyle(e).fontSize));assert.ok(fonts.every(s=>Math.abs(parseFloat(s)-11)<.1),JSON.stringify([...new Set(fonts)]));
 await page.getByLabel('Chart set name').fill(savedName);await page.getByRole('button',{name:'Pin chart set',exact:true}).click();await page.getByText('Chart set pinned privately.',{exact:false}).waitFor();
 await page.reload();await page.getByRole('button',{name:'Charts',exact:true}).click();await page.getByLabel('Saved chart sets').selectOption({label:savedName});
 await page.locator('.chart-card').nth(2).waitFor();
 assert.equal(await page.locator('.chart-card').count(),3);
 await page.locator('.chart-card').first().getByLabel('Time window').selectOption('fixed');
 const fixedFrom=await page.locator('.chart-card').first().getByLabel('From',{exact:true}).inputValue();
 await page.getByRole('button',{name:'Update pinned set',exact:true}).click();await page.getByText('Chart set pinned privately.',{exact:false}).waitFor();
 await page.reload();await page.getByRole('button',{name:'Charts',exact:true}).click();await page.getByLabel('Saved chart sets').selectOption({label:savedName});
 assert.equal(await page.locator('.chart-card').first().getByLabel('From',{exact:true}).inputValue(),fixedFrom);
 await page.getByRole('button',{name:'Ask Vishnu',exact:true}).click();delay=1500;replacement=makeChart('line');replacement.title='Deferred chart';
 await ask('Add another chart');await page.locator('.chart-card').nth(1).locator('select').nth(1).selectOption('60');
 await page.getByRole('button',{name:'Apply suggested view',exact:true}).waitFor();assert.equal(await page.locator('.chart-card').count(),3);
 await page.getByRole('button',{name:'Apply suggested view',exact:true}).click();await page.getByRole('article',{name:'Deferred chart',exact:true}).waitFor();
 await page.getByRole('button',{name:'Restore previous view',exact:true}).click();assert.equal(await page.locator('.chart-card').count(),3);
 await page.getByRole('button',{name:'Expand mesh',exact:true}).click();assert.equal(await page.locator('.workspace.mesh-minimized').count(),0);
 await page.screenshot({path:'/tmp/vishnu-charts-browser.png',fullPage:true});
 await page.getByRole('button',{name:'Delete saved set',exact:true}).click();await page.getByText('Private saved view deleted.',{exact:false}).waitFor();savedName='';
 await page.getByRole('button',{name:'Reset view',exact:true}).click();assert.equal(await page.locator('.chart-workspace').count(),0);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',checks:['Enter sends; Alt+Enter inserts newline; IME does not send','composer remains visible with long answers and scrolling charts','chat line/histogram/scatter rendering','11px fonts','private Postgres save/load across reload','fixed date persistence','manual change race and apply','restore without reload','mesh minimize/expand','delete/reset'],screenshot:'/tmp/vishnu-charts-browser.png'}));
} catch(e) { console.error('Browser diagnostic', JSON.stringify({errors,cards:await page.locator('.chart-card').allTextContents()}));await page.screenshot({path:'/tmp/vishnu-chart-failure.png',fullPage:true});throw e; } finally { if(savedName){await page.evaluate(async name=>{const r=await fetch('/api/chart-views');const d=await r.json();for(const v of d.views??[])if(v.name===name)await fetch(`/api/chart-views/${v.id}`,{method:'DELETE'});},savedName).catch(()=>{});}await browser.close(); }
