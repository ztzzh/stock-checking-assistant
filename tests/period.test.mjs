import test from 'node:test';
import assert from 'node:assert/strict';
import {periodReturn,rankHistoricalSectors,selectHistoricalSector,validateLookback} from '../script/period.mjs';
const bars=Array.from({length:31},(_,n)=>({date:new Date(Date.UTC(2026,7,3+n*2)).toISOString().slice(0,10),close:100+n}));
const sector=(code,kind,history=bars)=>({code,name:'合成'+code,kind,bars:history});
test('15/30个交易日收益需要16/31个收盘值，不按日历天数截断',()=>{
  const a=periodReturn(bars,15),b=periodReturn(bars,30);
  assert.equal(a.baseDate,bars[15].date);assert.equal(a.endDate,bars[30].date);assert.equal(a.rate,(130/115-1)*100);
  assert.equal(b.baseClose,100);assert.equal(b.endClose,130);assert.equal(b.rate,30.000000000000004);
  assert.equal(periodReturn(bars.slice(-15),15).eligible,false);assert.equal(periodReturn(bars.slice(-30),30).eligible,false);
});
test('缺日期、重复日期、零值、不完整覆盖或数据失败均不能默默算成强势',()=>{
  assert.throws(()=>periodReturn([{date:'2026-02-31',close:100}],15));
  assert.throws(()=>periodReturn([...bars,bars[0]],15));assert.throws(()=>periodReturn(bars.map((b,n)=>n?b:{...b,close:0}),15));
  assert.throws(()=>rankHistoricalSectors([sector('BK0001','industry')],30,{expectedCount:2}),/覆盖不完整/);
  assert.throws(()=>rankHistoricalSectors([{...sector('BK0001','industry'),error:'合成获取失败'}],30),/停止不完整排名/);
  assert.throws(()=>validateLookback(20));
});
test('行业概念用同一历史周期合并排序，今日最强不决定近期最强',()=>{
  const earlier=bars.map((b,n)=>({...b,close:100+2*n}));
  const ranking=rankHistoricalSectors([sector('BK0001','industry'),sector('BK0002','concept',earlier)],30);
  assert.equal(selectHistoricalSector(ranking,1).code,'BK0002');assert.equal(ranking.asOf,bars.at(-1).date);assert.match(ranking.label,/30个交易日/);
});
test('不同截止日不混排，新板块历史不足明确排除；并列不偷偷按代码选',()=>{
  assert.throws(()=>rankHistoricalSectors([sector('BK0001','industry'),sector('BK0002','concept',bars.slice(0,-1))],15),/截止交易日不同/);
  const ranking=rankHistoricalSectors([sector('BK0001','industry'),sector('BK0002','concept',bars.slice(-8))],30);
  assert.equal(ranking.excluded.length,1);assert.equal(ranking.excluded[0].availableBars,8);
  const tied=rankHistoricalSectors([sector('BK0001','industry'),sector('BK0002','concept')],30);assert.throws(()=>selectHistoricalSector(tied,1),/并列/);
});
