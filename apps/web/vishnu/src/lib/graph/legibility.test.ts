import { describe,it,expect } from 'vitest';
import { createSignalDemo } from '../fixtures/signals';
import { layoutMesh } from './layout';
import { focusLayout, layoutTween } from './focus-layout';
import { placeLabels, overlaps } from './label-placement';

describe('focus and context geometry',()=>{
 it('retains connectivity, enlarges the focus and shrinks context, with exact reversible endpoints',async()=>{
  const mesh=createSignalDemo();const base=await layoutMesh(mesh);const focused=focusLayout(base,mesh,new Set(['programs','scheduling']));
  expect(focused.nodes.map(n=>n.id).sort()).toEqual(base.nodes.map(n=>n.id).sort());
  expect(focused.edges.map(e=>e.id)).toEqual(base.edges.map(e=>e.id));
  expect(focused.nodes.find(n=>n.id==='programs')!.width).toBeGreaterThan(base.nodes.find(n=>n.id==='programs')!.width);
  expect(focused.nodes.filter(n=>n.context)).toHaveLength(7);
  for(const edge of focused.edges) {
   const r=mesh.relationships.find(r=>r.id===edge.id)!;
   const source=focused.nodes.find(n=>n.id===r.source)!;const target=focused.nodes.find(n=>n.id===r.target)!;
   expect([source.x,source.x+source.width]).toContain(edge.points[0].x);
   expect([target.x,target.x+target.width]).toContain(edge.points.at(-1)!.x);
  }
  const tween=layoutTween(base,focused);const half=tween(.5);
  expect(half.nodes.find(n=>n.id==='programs')!.width).toBe(244);
  expect(tween(1)).toBe(focused);expect(layoutTween(half,base)(1)).toBe(base);
 });
});
describe('screen-space path labels',()=>{
 const viewport={x:0,y:0,width:700,height:500};
 const inputs=[{id:'important',priority:10,width:220,points:[{x:30,y:200},{x:650,y:200}]},{id:'second',priority:0,width:220,points:[{x:30,y:200},{x:650,y:200}]}];
 it('keeps labels clear of nodes and each other',()=>{
  const obstacles=[{x:240,y:150,width:160,height:100}];
  const result=placeLabels(inputs,obstacles,viewport,1);
  expect(result.placed.length).toBeGreaterThan(0);
  for(const label of result.placed) expect(obstacles.some(o=>overlaps(label,o))).toBe(false);
  if(result.placed.length===2)expect(overlaps(result.placed[0],result.placed[1])).toBe(false);
 });
 it('uses readable-size markers at low zoom and restores text with enough space',()=>{
  expect(placeLabels(inputs.slice(0,1),[],viewport,.3).placed[0]).toMatchObject({compact:true,width:18,height:18});
  expect(placeLabels(inputs.slice(0,1),[],viewport,1).placed[0].compact).toBe(false);
 });
 it('reports crowded paths instead of drawing text under a node',()=>{
  expect(placeLabels(inputs,[viewport],viewport,1)).toEqual({placed:[],crowded:['important','second']});
 });
});
