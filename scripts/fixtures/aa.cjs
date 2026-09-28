// Synthetic public-page data; values are test fixtures, not leaderboard claims.
const row = (slug,name,release,effort,intelligence,coding) => ({slug,name,release:{slug:release},isReasoning:true,effort:{slug:effort},intelligenceIndex:intelligence,intelligenceIndexIsEstimated:false,terminalBench40:coding,price1mInputTokens:1,price1mOutputTokens:3})
const rows = [row('glm-5-3','GLM-5.3 (max)','glm-5-3','max',60,.6),row('glm-5-3-low','GLM-5.3 (low)','glm-5-3','low',20,.2),row('kimi-k3','Kimi K3 (max)','kimi-k3','max',50,.5),row('kimi-k3-low','Kimi K3 (low)','kimi-k3','low',30,.3),row('glm-5-3-flash','GLM 5.3 Flash','glm-5-3-flash','max',40,.4)]
function aaHtml(items=rows,catalog=rows.map(r=>({slug:r.slug,name:r.name,releaseSlug:r.release.slug}))) {
  const flight='0:'+JSON.stringify({initialModels:items,modelsAndReleases:{models:catalog}})+'\n'
  return '<html><head><title>Models | Artificial Analysis</title></head><body><script>self.__next_f.push('+JSON.stringify([1,flight])+')</script></body></html>'
}
module.exports={rows,aaHtml}
