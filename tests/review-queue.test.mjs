import test from 'node:test';import assert from 'node:assert/strict';
import {ReviewQueue,reviewWorkers} from '../script/review-queue.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function clock(){let now=0,sequence=0;const tasks=new Map();return{now:()=>now,schedule:(fn,ms)=>{const id=++sequence;tasks.set(id,{fn,at:now+ms});return id;},cancel:id=>tasks.delete(id),advance:async ms=>{now+=ms;for(const [id,t]of [...tasks])if(t.at<=now){tasks.delete(id);t.fn();}for(let n=0;n<6;n++)await Promise.resolve();},tasks};}
test('首张立即送审，满3张启动下一批；同码不重复，尾批不足3张也完成',async()=>{
 const calls=[],time=clock(),q=new ReviewQueue({clock:time,process:async codes=>calls.push(codes)});q.add(['a']);assert.deepEqual(calls,[['a']]);await q.worker;
 q.add(['b','c']);assert.equal(calls.length,1);q.add(['a','b','d']);assert.deepEqual(calls,[['a'],['b','c','d']]);await q.worker;q.add(['e']);await q.finish();assert.deepEqual(calls,[['a'],['b','c','d'],['e']]);assert.equal(q.state().completed,5);assert.equal(time.tasks.size,0);
});
test('不足3张时从最早入队开始等10秒，新图到达不重置期限',async()=>{
 const calls=[],time=clock(),q=new ReviewQueue({clock:time,process:async codes=>calls.push(codes)});q.add(['a']);await q.worker;q.add(['b']);await time.advance(9000);q.add(['c']);await time.advance(999);assert.equal(calls.length,1);await time.advance(1);assert.deepEqual(calls,[['a'],['b','c']]);await q.finish();assert.equal(time.tasks.size,0);
});
test('已有审核占用时不并发第二次；空闲后处理超时队列，采图入队无需等待模型',async()=>{
 const calls=[],release=deferred(),time=clock(),q=new ReviewQueue({clock:time,process:async codes=>{calls.push(codes);if(calls.length===1)await release.promise;}});q.add(['a']);q.add(['b','c']);await time.advance(12000);assert.equal(calls.length,1);assert.equal(q.state().active,1);assert.equal(q.state().queued,2);release.resolve();await q.worker;await q.finish();assert.deepEqual(calls,[['a'],['b','c']]);assert.equal(time.tasks.size,0);
});
test('取消清除等待定时器，不提交迟到图片；失败也不自动重试',async()=>{
 const calls=[],time=clock(),controller=new AbortController(),q=new ReviewQueue({clock:time,signal:controller.signal,process:async codes=>calls.push(codes)});q.add(['a']);await q.worker;q.add(['b']);controller.abort(Error('合成停止'));await time.advance(12000);await assert.rejects(q.finish(),/合成停止/);assert.deepEqual(calls,[['a']]);assert.equal(time.tasks.size,0);
 let attempts=0;const failed=new ReviewQueue({clock:time,process:async()=>{attempts++;throw Error('合成额度错误');}});failed.add(['a']);await failed.worker;failed.add(['b','c','d']);await assert.rejects(failed.finish(),/合成额度错误/);assert.equal(attempts,1);assert.equal(time.tasks.size,0);
});

test('审核路数支持1—32，三路批次去重分配且不会超出并发上限',async()=>{
 for(const n of [1,2,3,4,6,8,10,12,16,24,32])assert.equal(reviewWorkers(String(n)),n);for(const n of [0,33,1.5,true,null,''])assert.throws(()=>reviewWorkers(n),/审核路数/);
 const release=deferred(),calls=[];let active=0,max=0;const q=new ReviewQueue({workers:3,process:async codes=>{max=Math.max(max,++active);calls.push(codes);await release.promise;active--;}});
 q.add(['a','b','c','d','e','f','g','h','i','j']);q.add(['a','h']);assert.equal(q.state().activeWorkers,3);assert.equal(q.state().active,7);assert.equal(q.state().queued,3);assert.deepEqual(calls,[['a'],['b','c','d'],['e','f','g']]);release.resolve();await q.finish();assert.equal(max,3);assert.equal(q.completed,10);assert.equal(new Set(calls.flat()).size,10);assert.equal(q.state().activeWorkers,0);
});

test('下拉的高并发档位实际填满，各批只占自己的队列槽且代码不重分配',async()=>{
 for(const workers of [12,24,32]){
  const release=deferred(),calls=[],codes=Array.from({length:1+(workers-1)*3+6},(_,n)=>String(n));let active=0,max=0;
  const q=new ReviewQueue({workers,process:async batch=>{max=Math.max(max,++active);calls.push(batch);await release.promise;active--;}});q.add(codes);q.add(codes.slice(0,10));assert.equal(q.state().activeWorkers,workers);assert.equal(calls.length,workers);release.resolve();await q.finish();assert.equal(max,workers);assert.equal(q.completed,codes.length);assert.equal(new Set(calls.flat()).size,codes.length);assert.equal(calls.flat().length,codes.length);assert.equal(q.state().activeWorkers,0);
 }
});

test('多路中单批失败停止新分配，已在途的成功批次仍完成，不重试失败项',async()=>{
 const release=deferred(),started=deferred();let calls=0;const q=new ReviewQueue({workers:3,process:async codes=>{if(++calls===3)started.resolve();await release.promise;if(codes.includes('b'))throw Error('合成失败');}});q.add(['a','b','c','d','e','f','g','h']);await started.promise;release.resolve();await assert.rejects(q.finish(),/合成失败/);assert.equal(calls,3);assert.equal(q.completed,4);assert.equal(q.state().queued,1);assert.equal(q.state().activeWorkers,0);
});
