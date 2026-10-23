import type { Point } from './types';
export interface Box { x:number; y:number; width:number; height:number }
export interface LabelInput { id:string; points:Point[]; width:number; shortWidth?:number; priority:number; compact?:boolean }
export interface PlacedLabel extends Box { id:string; compact:boolean; short?:boolean }
export function overlaps(a:Box,b:Box,padding=6) {
  return a.x < b.x+b.width+padding && a.x+a.width+padding > b.x && a.y < b.y+b.height+padding && a.y+a.height+padding > b.y;
}
/** Coordinates and text widths are in screen pixels, so low zoom cannot shrink text into noise. */
export function placeLabels(inputs:LabelInput[], obstacles:Box[], viewport:Box, zoom:number) {
  const placed:PlacedLabel[]=[]; const crowded:string[]=[];
  const fits=(box:Box)=>box.x>=8 && box.y>=8 && box.x+box.width<=viewport.width-8 && box.y+box.height<=viewport.height-8 && !obstacles.some(o=>overlaps(box,o,8)) && !placed.some(o=>overlaps(box,o,6));
  for(const input of [...inputs].sort((a,b)=>b.priority-a.priority || a.id.localeCompare(b.id))) {
    const segments=input.points.slice(1).map((b,i)=>({a:input.points[i],b,length:Math.hypot(b.x-input.points[i].x,b.y-input.points[i].y)})).sort((a,b)=>b.length-a.length);
    let found:PlacedLabel|undefined;
    for(const level of (input.compact || zoom<.62 ? (input.shortWidth ? ['short','icon'] : ['icon']) : ['full',...(input.shortWidth ? ['short'] : []),'icon'])) {
      const compact=level==='icon';
      const width=compact?18:Math.ceil(level==='short' ? input.shortWidth! : input.width)+22, height=compact?18:28;
      for(const segment of segments) {
        const horizontal=Math.abs(segment.b.x-segment.a.x)>=Math.abs(segment.b.y-segment.a.y);
        if(!compact && segment.length<(horizontal?width+24:height+24)) continue;
        for(const fraction of [.5,.3,.7,.15,.85]) {
          const x=segment.a.x+(segment.b.x-segment.a.x)*fraction;
          const y=segment.a.y+(segment.b.y-segment.a.y)*fraction;
          for(const offset of compact?[0,20,-20]:horizontal?[-20,20,0]:[0,-width/2-18,width/2+18]) {
            const box={x:x-width/2+(!horizontal?offset:0),y:y-height/2+(horizontal?offset:0),width,height};
            if(fits(box)){found={...box,id:input.id,compact,short:level==='short'};break;}
          }
          if(found)break;
        }
        if(found)break;
      }
      if(found)break;
    }
    if(found)placed.push(found);else crowded.push(input.id);
  }
  return {placed,crowded};
}
