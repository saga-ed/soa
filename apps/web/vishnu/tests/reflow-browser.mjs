import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1600,height:1000}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const base=process.env.VISHNU_TEST_URL??'http://127.0.0.1:11930';
const settled=()=>page.waitForFunction(()=>document.querySelector('.graph-label-layer')?.getAttribute('data-layout-moving')==='false');
const geometry=()=>page.locator('.svelte-flow__node').evaluateAll(ns=>ns.map(n=>[n.dataset.id,n.style.transform]).sort());
async function clearLabels(){
 const collisions=await page.evaluate(()=>{
  const labels=[...document.querySelectorAll('.path-label')].map(e=>e.getBoundingClientRect());
  const nodes=[...document.querySelectorAll('.system-node,.bus-panel')].map(e=>e.getBoundingClientRect());
  const hit=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  return labels.flatMap((a,i)=>[...nodes,...labels.slice(i+1)].filter(b=>hit(a,b))).length;
 });assert.equal(collisions,0,'labels must not cover nodes or each other');
}
try {
 await page.goto(`${base}/?mode=demo`);await page.locator('.path-label').first().waitFor();await settled();await clearLabels();
 const original=await geometry();const count=await page.locator('.svelte-flow__edge').count();
 const marker=page.locator('.path-label.compact').first();await marker.focus();await page.getByRole('tooltip').waitFor();assert.ok((await page.getByRole('tooltip').innerText()).includes('→'));await page.keyboard.press('Escape');assert.equal(await page.getByRole('tooltip').count(),0);
 await page.getByLabel('Signal view').selectOption('fanout');await page.waitForFunction(()=>document.querySelectorAll('.context-node').length===7);await settled();await clearLabels();
 assert.equal(await page.locator('.svelte-flow__node').count(),9);assert.equal(await page.locator('.svelte-flow__edge').count(),count);assert.notDeepEqual(await geometry(),original);
 await page.screenshot({path:'/tmp/vishnu-focus-final.png'});
 await page.getByLabel('Signal view').selectOption('overview');await page.waitForFunction(()=>document.querySelectorAll('.context-node').length===0);await settled();assert.deepEqual(await geometry(),original);await clearLabels();
 await page.getByLabel('Signal view').selectOption('hot');await page.getByLabel('Signal view').selectOption('slow');await page.getByLabel('Signal view').selectOption('fanout');await settled();assert.equal(await page.locator('.svelte-flow__node').count(),9);
 await page.getByLabel('Reflow signal focus').uncheck();await page.waitForFunction(()=>document.querySelectorAll('.context-node').length===0);await settled();assert.deepEqual(await geometry(),original);
 await page.emulateMedia({reducedMotion:'reduce'});await page.getByLabel('Reflow signal focus').check();await page.waitForFunction(()=>document.querySelectorAll('.context-node').length===7);await settled();await clearLabels();
 assert.deepEqual(errors,[]);console.log('PASS: collision-free labels, keyboard tooltips, focus/context morph, preserved connectivity, exact restoration, rapid changes and reduced motion');
} finally {await browser.close();}
