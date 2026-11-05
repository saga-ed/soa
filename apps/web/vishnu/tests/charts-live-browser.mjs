import assert from 'node:assert/strict';
import {chromium} from 'playwright';
if(process.env.VISHNU_LIVE_AGENT!=='true')throw new Error('Set VISHNU_LIVE_AGENT=true for the paid real Bedrock demonstration.');
const base=process.env.VISHNU_TEST_URL??'http://127.0.0.1:11930';
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1800,height:1200},...(process.env.VISHNU_TEST_STORAGE_STATE?{storageState:process.env.VISHNU_TEST_STORAGE_STATE}:{}),...(process.env.VISHNU_TEST_BLUE==='true'?{extraHTTPHeaders:{'x-saga-preview-vishnu-api':'blue'}}:{})});
const page=await context.newPage();page.setDefaultTimeout(110000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(base);await page.getByRole('button',{name:'Ask Vishnu',exact:true}).click();
 await page.getByLabel('What would you like to investigate?').fill('Create three charts for iam-api: a line graph of average and maximum latency for the last week; a histogram of retained request durations for the last week; and a CPU versus memory scatter plot for the last 30 minutes. Display all three even if a data source is empty. Summarize actual availability in under 70 words.');
 await page.getByRole('button',{name:'Investigate',exact:true}).click();await page.getByRole('button',{name:'Stop',exact:true}).waitFor();await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'hidden'});
 const message=await page.locator('.assistant-panel').innerText();
 assert.equal(await page.locator('.assistant-panel [role="alert"]').count(),0,message);
 assert.equal(await page.locator('.chart-card').count(),3,message);
 await page.waitForFunction(()=>!document.querySelector('.chart-workspace [role="status"]')?.textContent?.includes('Loading'));
 await page.screenshot({path:'/tmp/vishnu-charts-live.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'passed',target:base,charts:await page.locator('.chart-card>header strong').allTextContents(),answer:await page.locator('.assistant-messages article').last().innerText(),screenshot:'/tmp/vishnu-charts-live.png'}));
}finally{await browser.close();}
