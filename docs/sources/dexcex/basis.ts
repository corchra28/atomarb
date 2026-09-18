const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const SOL='So11111111111111111111111111111111111111112'
const jq=async(a:string,b:string,amt:bigint)=>{const r=await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${a}&outputMint=${b}&amount=${amt}&slippageBps=0&restrictIntermediateTokens=true`);const j=await r.json() as any;return j.outAmount?BigInt(j.outAmount):null}
const walk=(l:[string,string][],usd:number)=>{let s=0,u=0;for(const[p,q]of l){const px=Number(p),t=Math.min(px*Number(q),usd-s);if(t<=0)break;s+=t;u+=t/px}return s>usd*0.98?{avg:s/u,units:u}:null}
for(let i=0;i<3;i++){
  const basis=await jq(USDC,USDT,2_000_000_000n)
  const bk=await(await fetch('https://api.binance.com/api/v3/depth?symbol=USDCUSDT&limit=20')).json() as any
  const bsell=walk(bk.bids,2000)
  const solBook=await(await fetch('https://api.binance.com/api/v3/depth?symbol=SOLUSDT&limit=50')).json() as any
  const solSell=walk(solBook.bids,2000)
  const outUsdc=await jq(USDC,SOL,2_000_000_000n)
  const outUsdt=await jq(USDT,SOL,2_000_000_000n)
  const gap=(o:bigint|null)=>{if(!o||!solSell)return NaN;const u=Number(o)/1e9;return ((solSell.avg-2000/u)/(2000/u))*1e4}
  console.log(JSON.stringify({
    t:new Date().toISOString(),
    basis_dex_bps:basis?+(((Number(basis)/2e9)-1)*1e4).toFixed(2):null,
    basis_cex_bps:bsell?+(((bsell.avg)-1)*1e4).toFixed(2):null,
    sol_gap_unmatched_usdc_bps:+gap(outUsdc).toFixed(2),
    sol_gap_matched_usdt_bps:+gap(outUsdt).toFixed(2),
  }))
  await new Promise(r=>setTimeout(r,4000))
}
