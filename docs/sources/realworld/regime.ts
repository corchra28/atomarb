/** Is this hour busier or quieter than the one the first census sampled? */
const RPC=process.env.SOLANA_RPC_URL!
const rpc=async(m:string,p:unknown[])=>{const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const j=await r.json() as any;if(j.error)throw new Error(JSON.stringify(j.error));return j.result}
// chain activity
const perf=await rpc('getRecentPerformanceSamples',[5])
const tps=perf.map((p:any)=>p.numTransactions/p.samplePeriodSecs)
console.log('TPS pe ultimele 5 mostre:', tps.map((t:number)=>t.toFixed(0)).join(', '))
console.log('slot/s:', (perf[0].numSlots/perf[0].samplePeriodSecs).toFixed(3))
// priority fee level, on the same accounts the earlier run used (busy AMM pools)
const fees=await rpc('getRecentPrioritizationFees',[['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc']])
const vals=fees.map((f:any)=>f.prioritizationFee).sort((a:number,b:number)=>a-b)
const q=(p:number)=>vals[Math.floor(vals.length*p)]
console.log('priority fee micro-lamports/CU: mostre',vals.length,'| p50',q(0.5),'p75',q(0.75),'p90',q(0.9),'p99',q(0.99))
console.log('mostre cu fee 0:',vals.filter((v:number)=>v===0).length,'din',vals.length)
// SOL volatility right now, 1-minute bars
const k=await (await fetch('https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=120')).json() as any[]
const rets:number[]=[]
for(let i=1;i<k.length;i++) rets.push(Math.log(Number(k[i][4])/Number(k[i-1][4])))
const mean=rets.reduce((a,b)=>a+b,0)/rets.length
const sd=Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/(rets.length-1))
console.log('SOL 1-min sigma acum:',(sd*1e4).toFixed(2),'bps (peste ultimele 2 ore)')
console.log('pret SOL:',Number(k[k.length-1][4]).toFixed(2))
