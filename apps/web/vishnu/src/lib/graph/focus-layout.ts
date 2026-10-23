import type { MeshLayout, MeshSnapshot, Point } from './types';

/** A stable context frame around an expanded focus area. Every node and edge survives. */
export function focusLayout(base: MeshLayout, snapshot: MeshSnapshot, focus: Set<string>): MeshLayout {
  if (!focus.size) return base;
  const active = base.nodes.filter(n => focus.has(n.id));
  const quiet = base.nodes.filter(n => !focus.has(n.id));
  const band = (id: string) => snapshot.systems.find(s => s.id === id)!.band;
  const bands = ['data', 'mesh', 'application'].filter(b => active.some(n => band(n.id) === b));
  const height = Math.max(560, Math.ceil(quiet.length / 2) * 82 + 140, ...bands.map(b => active.filter(n => band(n.id) === b).length * 240 + 160));
  const width = 1320;
  const nodes = [
    ...quiet.map((n, i) => ({ ...n, x: i % 2 ? 1140 : 40, y: 80 + Math.floor(i / 2) * 82, width: 140, height: 64, context: true })),
    ...bands.flatMap((b, column) => {
      const rows = active.filter(n => band(n.id) === b);
      return rows.map((n, i) => ({ ...n, x: bands.length === 1 ? 548 : 280 + column * (760 / bands.length), y: height / 2 - rows.length * 240 / 2 + i * 240, width: 264, height: 132, context: false }));
    }),
  ];
  const byId = new Map(nodes.map(n => [n.id,n]));
  const edges = base.edges.map((edge, i) => {
    const r = snapshot.relationships.find(r => r.id === edge.id)!;
    const a = byId.get(r.source)!, b = byId.get(r.target)!;
    const sameColumn = a.x === b.x;
    const rightward = b.x > a.x;
    const start = { x: sameColumn || rightward ? a.x+a.width : a.x, y:a.y+a.height/2 };
    const end = { x: sameColumn ? b.x+b.width : rightward ? b.x : b.x+b.width, y:b.y+b.height/2 };
    const lane = sameColumn ? Math.max(a.x+a.width,b.x+b.width)+60+(i%5)*18 : (start.x+end.x)/2+(i%3-1)*14;
    return {id:edge.id,points:[start,{x:lane,y:start.y},{x:lane,y:end.y},end]};
  });
  return {nodes,edges,width,height};
}
function sample(points: Point[], count = 24): Point[] {
  const lengths = points.slice(1).map((p,i)=>Math.hypot(p.x-points[i].x,p.y-points[i].y));
  const total = lengths.reduce((a,b)=>a+b,0);
  return Array.from({length:count},(_,i)=>{
    let distance=total*i/(count-1);
    for(let j=0;j<lengths.length;j++) {
      if(distance<=lengths[j] || j===lengths.length-1) {const t=lengths[j]?distance/lengths[j]:0;return {x:points[j].x+(points[j+1].x-points[j].x)*t,y:points[j].y+(points[j+1].y-points[j].y)*t};}
      distance-=lengths[j];
    }
    return points[0] ?? {x:0,y:0};
  });
}
/** Resampling allows arbitrary orthogonal routes to morph while keeping endpoints attached. */
export function layoutTween(from: MeshLayout, to: MeshLayout) {
  const oldNodes=new Map(from.nodes.map(n=>[n.id,n]));
  const oldEdges=new Map(from.edges.map(e=>[e.id,e]));
  const paths=to.edges.map(e=>({id:e.id,a:sample(oldEdges.get(e.id)?.points ?? e.points),b:sample(e.points)}));
  const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
  return (t:number):MeshLayout => t>=1 ? to : ({
    width:mix(from.width,to.width,t),height:mix(from.height,to.height,t),
    nodes:to.nodes.map(n=>{const a=oldNodes.get(n.id)??n;return {...n,x:mix(a.x,n.x,t),y:mix(a.y,n.y,t),width:mix(a.width,n.width,t),height:mix(a.height,n.height,t)};}),
    edges:paths.map(p=>({id:p.id,points:p.b.map((b,i)=>({x:mix(p.a[i].x,b.x,t),y:mix(p.a[i].y,b.y,t)}))})),
  });
}
