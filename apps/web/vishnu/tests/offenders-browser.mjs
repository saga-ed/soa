import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({viewport:{width:1600,height:1100}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
const now=Date.now();
let variant='available';
const response=()=>({version:1,status:'connected',observedAt:new Date(variant==='stale'?now-900000:now).toISOString(),serverNow:now,freshForMs:300000,scope:{environment:'synthetic',deployment:variant==='wrong-scope'?'slot-0':'slot-3',deploymentTag:'deployment.identifier'},appUrl:'https://app.datadoghq.com',window:{from:now-900000,to:now},thresholds:{hotRate:10,warningP95Ms:2500,criticalP95Ms:5000},services:[],dependencies:[],pathEndpointStatus:variant==='unavailable'?'unavailable':'available',pathEndpoints:variant==='empty'?[]:[...Array.from({length:7},(_,i)=>({source:'a',target:'b',resource:`GET /endpoint-${i+1}`,observedSpans:(i+1)*10,p95Ms:(8-i)*100})),{source:'a',target:'c',resource:'GET /other-path',observedSpans:9999,p95Ms:9999}],fanoutStatus:'available',fanoutCoverage:{requestedTraces:8,retrievedTraces:7,usableTraces:6,rejectedTraces:1,limited:true,basis:'recent-retained-trace-sample',observedAt:new Date(now).toISOString()},fanout:[{source:'a',target:'b',resource:'GET /child',parentResource:'GET /parent',sampledParents:4,observedCalls:12,maxCallsPerParent:5,meanCallsPerParent:3,traceIds:[]}]});
await page.route('**/config.json',r=>r.fulfill({json:{mode:'live',mqEnabled:false}}));
await page.route('**/api/mesh',r=>r.fulfill({json:{topologyVersion:'offenders-test',environment:'synthetic-dev',slot:3,mode:'live',observedAt:new Date(now).toISOString(),observationWindowSeconds:900,systems:['a','b','c'].map(id=>({id,label:id,band:'mesh',kind:'API service',health:'healthy',freshness:'fresh',errors:null,summary:'Test',evidence:[]})),relationships:[{id:'ab',source:'a',target:'b',label:'A to B',kind:'http',protocol:'trpc',count:null,rate:null,latencyMs:null,health:'unknown',freshness:'missing',summary:'Test',evidence:[]},{id:'ac',source:'a',target:'c',label:'Database path',kind:'database',count:null,rate:null,latencyMs:null,health:'unknown',freshness:'missing',summary:'Test',evidence:[]}]}}));
await page.route('**/api/datadog',r=>r.fulfill({json:response()}));
const ranking=page.getByRole('region',{name:'Ranked path endpoints',exact:true});
async function selectPath(label='A to B',view='slow') {
 await page.getByLabel('Signal view').selectOption(view);
 await page.getByRole('button',{name:'Browse as list',exact:true}).click();
 await page.locator('#mesh-list').getByRole('button').filter({hasText:label}).click();
 await ranking.waitFor();
}
try {
 await page.goto(process.env.VISHNU_TEST_URL??'http://127.0.0.1:8936');
 await selectPath();
 assert.equal(await ranking.locator('li').count(),5);
 assert.match(await ranking.locator('li').first().innerText(),/endpoint-1/);
 assert.doesNotMatch(await ranking.innerText(),/other-path/);
 await page.getByRole('button',{name:'Display settings',exact:true}).click();
 await page.getByLabel('Top endpoints',{exact:true}).fill('2');
 assert.equal(await ranking.locator('li').count(),2,'open inspector updates immediately');
 await page.getByLabel('Top endpoints',{exact:true}).press('Escape');
 assert.equal(await page.getByRole('dialog',{name:'Display settings'}).count(),0);
 assert.equal(await ranking.count(),1,'Escape in settings preserves selection');
 assert.equal(await page.getByRole('button',{name:'Display settings',exact:true}).evaluate(e=>e===document.activeElement),true);
 await page.getByLabel('Signal view').selectOption('hot');
 assert.match(await ranking.locator('li').first().innerText(),/endpoint-7/);
 assert.match(await ranking.innerText(),/not total traffic/);
 await page.reload();
 await selectPath();
 assert.equal(await ranking.locator('li').count(),2,'limit persists across reload');
 await page.getByRole('button',{name:'Display settings',exact:true}).click();
 assert.equal(await page.getByLabel('Top endpoints',{exact:true}).inputValue(),'2');
 await page.getByLabel('Top endpoints',{exact:true}).fill('100');
 assert.equal(await ranking.locator('li').count(),7);
 await page.getByLabel('Signal view').click();
 assert.equal(await page.getByRole('dialog',{name:'Display settings'}).count(),0,'outside click dismisses');
 await page.getByLabel('Signal view').selectOption('fanout');
 assert.match(await ranking.innerText(),/3 calls \/ sampled parent/);
 assert.match(await ranking.innerText(),/4 sampled parents/);
 assert.match(await ranking.innerText(),/Parent: GET \/parent/);
 assert.match(await ranking.innerText(),/6 usable \/ 7 retrieved/);
 await ranking.scrollIntoViewIfNeeded();
 await page.screenshot({path:'/tmp/vishnu-offenders-browser.png'});
 await page.locator('#mesh-list').getByRole('button').filter({hasText:'Database path'}).click();
 assert.match(await ranking.innerText(),/unavailable for this connection type/);
 for (const state of ['empty','unavailable','wrong-scope','stale']) {
  variant=state;
  await page.reload();
  await selectPath();
  assert.equal(await ranking.locator('li').count(),0,state);
  assert.match(await ranking.innerText(),state==='empty'?/No measured endpoints/:state==='stale'?/stale/:/unavailable/);
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: path-specific Slow/Hot/Fan-out rankings, sample labels, limit persistence, keyboard dismissal, unsupported and stale/scope states');
} finally { await browser.close(); }
