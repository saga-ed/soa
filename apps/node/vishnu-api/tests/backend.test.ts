import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createVerifier } from '@saga-ed/janus-client/server';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatadogReader } from '../../../web/vishnu/server/datadog';
import { connectionLabel } from '../../../web/vishnu/src/lib/graph/presentation';
import { cloudMesh } from '../src/cloud-mesh.js';
import { matchesMesh } from '../../../web/vishnu/src/lib/graph/datadog';

const env = { VISHNU_ENVIRONMENT: 'dev', VISHNU_DATADOG_ENV: 'dev', VISHNU_DATADOG_DEPLOYMENT: 'blue' };
const config = loadConfig(env);
let server: Server, keysServer: Server, folder: string, privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const telemetry = { datadog: vi.fn(createDatadogReader(env)), eventStats: vi.fn(async () => ({ version: 1 })) };
const portOf = (s: Server) => (s.address() as { port: number }).port;
async function http(path: string, cookie?: string, extra: Record<string,string> = {}, method='GET') {
  return new Promise<{status: number; body: string; headers: Record<string,unknown>}>((resolve, reject) => {
    const req = request({host:'127.0.0.1', port:portOf(server), path, method, headers:{host:'vishnu.wootops.org', ...(cookie ? {cookie:`janus_session=${cookie}`} : {}), ...extra}}, res => {
      let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode!,body,headers:res.headers}));
    }); req.on('error',reject);req.end();
  });
}
async function token(permissions=['staff:support'], expired=false) {
  return new SignJWT({email:'test@example.invalid',name:'Test',permissions,authTime:Math.floor(Date.now()/1000)})
    .setProtectedHeader({alg:'EdDSA',kid:'test'}).setIssuer('janus').setAudience('wootdev').setSubject('staff-test')
    .setIssuedAt().setExpirationTime(expired ? Math.floor(Date.now()/1000)-120 : '5m').sign(privateKey);
}
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');privateKey=pair.privateKey;
  const key = {...await exportJWK(pair.publicKey),kid:'test',alg:'EdDSA'};
  keysServer=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({keys:[key]}));});
  await new Promise<void>(r=>keysServer.listen(0,'127.0.0.1',r));
  folder=await mkdtemp(join(tmpdir(),'vishnu-api-')); await writeFile(join(folder,'index.html'),'<h1>Private Vishnu</h1>');
  const {app}=await createApp(config,telemetry,{staticDir:folder,verifier:createVerifier({jwksUrl:`http://127.0.0.1:${portOf(keysServer)}/jwks`})});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
});
afterAll(async()=>{for(const s of [server,keysServer])if(s)await new Promise<void>(r=>s.close(()=>r()));if(folder)await rm(folder,{recursive:true});});
describe('hosted staff boundary',()=>{
 it('leaves health public but gates UI, JSON, tRPC and SOA framework routes',async()=>{
  expect((await http('/health')).status).toBe(200);
  const root=await http('/');expect(root.status).toBe(302);expect(root.headers.location).toBe('https://gate.wootops.org/callback?next=https%3A%2F%2Fvishnu.wootops.org%2F');
  for(const p of ['/config.json','/api/mesh','/trpc/telemetry.mesh','/api/v1/sectors/list'])expect((await http(p)).status).toBe(401);
  expect(telemetry.datadog).not.toHaveBeenCalled();
 });
 it('rejects forged, expired, and authenticated non-staff sessions',async()=>{
  expect((await http('/api/mesh','forged')).status).toBe(401);
  expect((await http('/api/mesh',await token(undefined,true))).status).toBe(401);
  expect((await http('/api/mesh',await token([]))).status).toBe(403);
 });
 it('serves the UI and same read contract through REST compatibility and tRPC',async()=>{
  const jwt=await token();expect((await http('/',jwt)).body).toContain('Private Vishnu');
  const rest=await http('/api/mesh',jwt);expect(rest.status).toBe(200);expect(JSON.parse(rest.body).scope.environment).toBe('dev');
  const rpc=await http('/trpc/telemetry.mesh',jwt);expect(rpc.status).toBe(200);expect(JSON.parse(rpc.body).result.data.scope.environment).toBe('dev');
 });
 it('rejects arbitrary targets, foreign origins, forged hosts and writes',async()=>{
  const jwt=await token();
  expect((await http('/api/mesh?target=http://metadata',jwt)).status).toBe(400);
  expect((await http('/api/mesh',jwt,{origin:'https://evil.invalid'})).status).toBe(403);
  expect((await http('/auth/login',undefined,{host:'evil.invalid'})).status).toBe(403);
  expect((await http('/trpc/telemetry.mesh',jwt,{},'POST')).status).toBe(405);
  expect((await http('/.env',jwt)).status).toBe(404);
 });
});
describe('scope isolation',()=>{
 it('fails closed on missing scope, cross-environment settings and auth bypass',()=>{
  for(const e of [{},{...env,VISHNU_DATADOG_DEPLOYMENT:''},{...env,JANUS_REQUIRED:'false'},{...env,VISHNU_ENVIRONMENT:'prod'},{...env,VISHNU_PUBLIC_ORIGIN:'https://evil.invalid'}]) expect(()=>loadConfig(e)).toThrow();
 });
 it('does not manufacture health, edges, or metrics and only matches exact cloud scope',async()=>{
  const data=await createDatadogReader(env)();const mesh=cloudMesh(data);
  expect(mesh.systems.map(s=>s.id)).toEqual(['coach','connectv3','saga_dash']);expect(mesh.relationships).toEqual([]);expect(mesh.systems.every(s=>s.health==='unknown')).toBe(true);
  const observed = cloudMesh({...data, dependencies: [{source:'saga_dash',target:'iam-api'}, {source:'saga_dash',target:'iam-api'}]});
  expect(observed.relationships).toHaveLength(1);
  expect(connectionLabel(observed.relationships[0])).toBe('APM');
  expect(observed.relationships[0].latencyMs).toBeNull();
  expect(matchesMesh(data,mesh)).toBe(true);expect(matchesMesh({...data,scope:{...data.scope,environment:'prod'}},mesh)).toBe(false);
 });
});
