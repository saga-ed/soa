import { describe, expect, it, vi } from 'vitest';
import { parseDatadogJson, pathEndpointMeasurements, pathGroupLimits, sampledFanout } from '../src/telemetry/datadog-paths';
import { createDatadogReader } from '../src/telemetry/datadog';

const scope = { level: 'deployment' as const, environment: 'synthetic', deployment: 'slot-3', deploymentTag: 'deployment.identifier', machine: 'turing' };
const observedAt = '2026-11-02T23:00:00Z';
const ok = (value: unknown) => ({status:'fulfilled' as const,value});
const failure = {status:'rejected' as const,reason:new Error('unavailable')};
const meta = (kind: string, path: string) => ({env:'synthetic','deployment.identifier':'slot-3','synthetic.machine':'turing','span.kind':kind,'http.method':'GET','http.path_group':path});
const server = (spanID: string) => ({spanID,service:'programs-api',meta:meta('server','/trpc/programs.list')});
const client = (spanID: string, parentID: string, path='/trpc/personas.getMyPermissions') => ({spanID,parentID,service:'programs-api',meta:{...meta('client',path),'peer.service':'iam-api'}});
const trace = (spans: unknown[], truncated=false) => ok({data:{attributes:{is_truncated:truncated,spans}}});

describe('path endpoint evidence',()=>{
  it('never folds whole-service measurements into a path and unions rankings without double counting',()=>{
    const bucket = {attributes:{by:{service:'programs-api','@peer.service':'iam-api','@http.method':'GET','@http.path_group':'/permissions'},compute:{c0:12,c1:250000000}}};
    const body = {data:[bucket,{attributes:{by:{service:'programs-api'},compute:{c0:999}}}],meta:{status:'done'}};
    const result=pathEndpointMeasurements([ok(body),ok(body)]);
    expect(result.pathEndpoints).toEqual([{source:'programs-api',target:'iam-api',resource:'GET /permissions',observedSpans:12,p95Ms:250}]);
    expect(result.pathEndpointStatus).toBe('partial');
    expect(pathGroupLimits.reduce((a,b)=>a*b)).toBeLessThanOrEqual(10000);
    expect(pathEndpointMeasurements([failure,failure]).pathEndpointStatus).toBe('unavailable');
  });
});

describe('bounded retained trace fan-out',()=>{
  it('preserves exact adjacent uint64 identifiers through raw JSON parsing',()=>{
    const data = parseDatadogJson('{"spanID":9007199254740992,"parentID":9007199254740993,"duration":123}');
    expect(data).toEqual({spanID:'9007199254740992',parentID:'9007199254740993',duration:123});
  });
  it('counts calls per observed parent request traversing the path, with zeros for other endpoints',()=>{
    const spans=[server('9007199254740992'),server('9007199254740993'),client('11','9007199254740992'),client('12','9007199254740992'),client('13','9007199254740992'),client('14','9007199254740993','/other')];
    const result=sampledFanout([{traceId:'abc',result:trace(spans)}],scope,observedAt);
    expect(result.fanout.find(r=>r.resource==='GET /trpc/personas.getMyPermissions')).toMatchObject({sampledParents:2,observedCalls:3,meanCallsPerParent:1.5,maxCallsPerParent:3});
    expect(result.fanout.find(r=>r.resource==='GET /other')).toMatchObject({sampledParents:2,observedCalls:1,meanCallsPerParent:0.5,maxCallsPerParent:1});
    expect(result.fanoutCoverage).toMatchObject({requestedTraces:1,usableTraces:1,rejectedTraces:0,limited:true,observedAt});
    expect(result.fanoutStatus).toBe('partial');
  });
  it('rejects truncated, restricted, duplicate, unsafe IDs and orphaned client samples',()=>{
    const valid=[server('1'),client('2','1')];
    const candidates=[trace(valid,true),trace([...valid,{spanID:'3',restricted:true}]),trace([...valid,client('2','1')]),trace([server('1'),client('2','missing')]),trace([server('1'),client('2','999')]),trace([server('1'),{...client('2','1'),spanID:9007199254740992}]),failure];
    const result=sampledFanout(candidates.map((result,i)=>({traceId:String(i),result})),scope,observedAt);
    expect(result.fanout).toEqual([]);expect(result.fanoutCoverage.rejectedTraces).toBe(7);expect(result.fanoutStatus).toBe('unavailable');
  });
  it('never mixes machine or deployment scopes and may use an actual callee server path',()=>{
    const c=client('2','1');delete (c.meta as Record<string,string>)['http.path_group'];
    const callee={spanID:'3',parentID:'2',service:'iam-api',meta:meta('server','/callee')};
    const crossScope={...client('4','1'),meta:{...client('4','1').meta,'synthetic.machine':'other'}};
    const result=sampledFanout([{traceId:'abc',result:trace([server('1'),c,callee,crossScope])}],scope,observedAt);
    expect(result.fanout).toHaveLength(1);expect(result.fanout[0]).toMatchObject({resource:'GET /callee',observedCalls:1});
  });
  it('bounds retrieval to five distinct IDs and caches the sample without refreshing its timestamp',async()=>{
    const calls:{url:URL;init?:RequestInit}[]=[];
    let clock=Date.parse(observedAt);
    const fetcher=vi.fn(async (input:string|URL|Request,init?:RequestInit)=>{
      const url=new URL(String(input));calls.push({url,init});
      if(url.pathname.endsWith('/events/search'))return new Response(JSON.stringify({data:Array.from({length:20},(_,i)=>({attributes:{trace_id:i === 0 ? '18bad00be00679a0db59c8475d72e8cc' : String(i+1)}}))}));
      if(url.pathname.startsWith('/api/v2/trace/'))return new Response(JSON.stringify({data:{attributes:{is_truncated:false,spans:[server('1'),client('2','1')]}}}));
      return new Response(JSON.stringify({data:[],meta:{status:'done'}}));
    });
    const read=createDatadogReader({DD_API_KEY:'secret',DD_APP_KEY:'secret',VISHNU_SLOT:'3',VISHNU_DATADOG_MACHINE:'turing'},fetcher as typeof fetch,()=>clock);
    const a=await read();clock+=120000;const b=await read();
    expect(calls.filter(c=>c.url.pathname.startsWith('/api/v2/trace/'))).toHaveLength(5);
    expect(calls.some(c=>c.url.pathname.endsWith('/18bad00be00679a0db59c8475d72e8cc'))).toBe(true);
    expect(a.fanoutCoverage?.requestedTraces).toBe(5);expect(b.fanoutCoverage?.observedAt).toBe(a.fanoutCoverage?.observedAt);
    for(const c of calls.filter(c=>c.init?.body))expect(JSON.parse(String(c.init?.body)).data.attributes.filter.query).toContain('@synthetic.machine:turing');
  });
});


describe('independent path availability',()=>{
  it('preserves path evidence when legacy queries and trace retrieval fail',async()=>{
    const fetcher=vi.fn(async (input:string|URL|Request,init?:RequestInit)=>{
      const url=new URL(String(input));
      const attrs=init?.body ? JSON.parse(String(init.body)).data.attributes : undefined;
      if(url.pathname.endsWith('/aggregate') && attrs?.group_by?.length===4)return new Response(JSON.stringify({data:[{attributes:{by:{service:'programs-api','@peer.service':'iam-api','@http.method':'GET','@http.path_group':'/permissions'},compute:{c0:1,c1:5000000}}}],meta:{status:'done'}}));
      return new Response('',{status:403});
    });
    for(const extra of [{VISHNU_DATADOG_ENV:'dev',VISHNU_DATADOG_SCOPE:'environment'},{VISHNU_SLOT:'3',VISHNU_DATADOG_MACHINE:'turing'}]){
      const result=await createDatadogReader({DD_API_KEY:'secret',DD_APP_KEY:'secret',...extra},fetcher as typeof fetch)();
      expect(result.status).toBe('partial');expect(result.pathEndpointStatus).toBe('available');expect(result.fanoutStatus).toBe('unavailable');
    }
  });
});
