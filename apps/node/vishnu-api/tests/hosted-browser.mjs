import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createVerifier } from '@saga-ed/janus-client/server';
import { createApp } from '../dist/app.js';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// A real signed test session against local JWKS, never a production auth bypass.
const pair = await generateKeyPair('EdDSA');
const publicKey = { ...await exportJWK(pair.publicKey), kid: 'browser-test', alg: 'EdDSA' };
const keys = createServer((_req,res) => { res.setHeader('Content-Type','application/json');res.end(JSON.stringify({keys:[publicKey]})); });
await new Promise(r=>keys.listen(0,'127.0.0.1',r));
const now = Date.now();
const snapshot = { version:1,status:'connected',message:'Browser test observations',observedAt:new Date(now).toISOString(),serverNow:now,freshForMs:180000,
  scope:{level:'environment',environment:'dev',deployment:'all',deploymentTag:'deployment.identifier'},appUrl:'https://app.datadoghq.com',window:{from:now-900000,to:now},
  thresholds:{hotRate:10,warningP95Ms:2500,criticalP95Ms:5000},
  services:[{service:'iam-api',rate:{at:now,value:12},p95Ms:{at:now,value:3000},errorRate:null,previousP95Ms:2000,monitors:[]}],
  dependencies:[{source:'saga_dash',target:'iam-api'}] };
// Only the test fixture uses a loopback origin; loadConfig never accepts it in hosted mode.
const config = {environment:'dev',origin:'http://127.0.0.1:11932',gateUrl:'https://gate.wootops.org',jwksUrl:`http://127.0.0.1:${keys.address().port}/jwks`,port:11932,permissions:['staff:support'],mqEnabled:false,deployment:'all',deploymentTag:'deployment.identifier'};
const {app}=await createApp(config,{datadog:async()=>snapshot,eventStats:async()=>{throw Error('Disabled');}}, {staticDir:resolve('../../web/vishnu/build'),verifier:createVerifier({jwksUrl:config.jwksUrl})});
const server=app.listen(11932,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const jwt=await new SignJWT({email:'test@example.invalid',name:'Browser test',permissions:['staff:support'],authTime:Math.floor(now/1000)})
   .setProtectedHeader({alg:'EdDSA',kid:'browser-test'}).setIssuer('janus').setAudience('wootdev').setSubject('test-staff').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
 await page.context().addCookies([{name:'janus_session',value:jwt,url:config.origin,httpOnly:true,sameSite:'Lax'}]);
 await page.goto(config.origin);
 await page.getByText('Datadog: connected',{exact:false}).waitFor();
 await page.getByText('MQ telemetry not enabled',{exact:false}).waitFor();
 await page.locator('.svelte-flow__node').first().waitFor();
 assert.equal(await page.getByText('separate scope; graph overlay disabled',{exact:false}).count(),0);
 await page.getByRole('button',{name:'Browse as list'}).click();
 await page.getByRole('button').filter({hasText:'iam-api'}).first().click();
 await page.getByRole('heading',{name:'Datadog APM'}).waitFor();
 assert.match(await page.locator('.datadog-stats').innerText(),/3,?000/);
 // Quiet APM windows keep real source declarations and do not become fake traffic.
 snapshot.dependencies=[]; snapshot.services=[];
 await page.reload();
 await page.locator('.svelte-flow__edge').first().waitFor();
 assert.ok(await page.locator('.svelte-flow__edge').count() >= 20);
 const ids=await page.locator('.svelte-flow__edge').evaluateAll(es=>es.map(e=>e.getAttribute('data-id')));
 assert.ok(ids.includes('declared:coach:coach-api'));
 await page.screenshot({path:'/tmp/vishnu-declared-quiet.png',fullPage:true});
 await page.locator('.svelte-flow__edge[data-id="declared:coach:coach-api"]').click({force:true});
 await page.getByText('Declared connection',{exact:true}).waitFor();
 await page.getByText('Not observed in APM window',{exact:false}).first().waitFor();
 assert.match(await page.locator('.inspector').innerText(),/HTTP\/GraphQL/);
 assert.match(await page.locator('.inspector').innerText(),/does not prove zero traffic/);
 await page.mouse.move(0,0);
 await page.keyboard.press('Escape');
 await page.screenshot({path:'/tmp/vishnu-hosted-browser.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('Hosted UI: staff auth, scope, MQ off, service metrics and persistent quiet-window declared edges passed');
} finally {
 await browser.close();
 await new Promise(r=>server.close(r));await new Promise(r=>keys.close(r));
}
