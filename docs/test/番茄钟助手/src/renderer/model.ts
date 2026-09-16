export type Mode='focus'|'short'|'long';export type Phase='idle'|'running'|'paused';export type History={phase:Mode;durationSec:number;completedAt:string;completed:boolean};
export const nextMode=(mode:Mode,completed:number):Mode=>mode==='focus'?(completed%4===0?'long':'short'):'focus';
export const validDuration=(v:number)=>Number.isFinite(v)&&v>=1&&v<=86400?v:null;
export const todayStats=(h:History[],now=new Date())=>{const d=now.toDateString(),x=h.filter(v=>new Date(v.completedAt).toDateString()===d&&v.phase==='focus'&&v.completed);return{count:x.length,seconds:x.reduce((a,v)=>a+v.durationSec,0)}};
