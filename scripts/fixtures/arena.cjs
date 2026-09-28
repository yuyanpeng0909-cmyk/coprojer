// Synthetic benchmark data for isolated tests; not real model performance claims.
const titles = { webdev: 'Code Arena | WebDev Overall', frontend: 'Code Arena | WebDev Frontend', fullstack: 'Code Arena | WebDev Fullstack', coding: 'Text Arena Coding', text: 'Text Arena Overall' }
const categories = { '/leaderboard/code': 'webdev', '/leaderboard/code/webdev/frontend': 'frontend', '/leaderboard/code/webdev/fullstack': 'fullstack', '/leaderboard/text/coding': 'coding', '/leaderboard/text': 'text' }
function arenaHtml(category, rows, date = new Date()) {
  return '<h1>' + titles[category] + '</h1><p>Controlled test fixture</p><span>' + date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) + '</span><span>' + rows.length + ' models</span><table><thead><tr>' + ['Rank','Rank Spread','Model','Score','Votes','Price $/M','Context'].map(s=>'<th>'+s+'</th>').join('') + '</tr></thead><tbody>' + rows.map((r,i)=>'<tr><td>'+(i+1)+'</td><td>1</td><td><span title="'+r.model+'">'+r.model+'</span></td><td>'+r.score+' <span>'+(r.ci === null ? '' : r.ci || '+10/-10')+'</span>'+(r.preliminary?' Preliminary':'')+'</td><td>'+(r.votes ?? 1500).toLocaleString('en-US')+'</td><td>'+(r.input === undefined ? 'N/A' : '$'+r.input+' / $'+r.output)+'</td><td>128K</td></tr>').join('')+'</tbody></table>'
}
function allocationFixture(url, a = 'reasoning-model', b = 'coding-model') {
  const category = categories[new URL(url).pathname]
  if (!category) throw Error('Unrecognized Arena category')
  const dev = category === 'coding' || category === 'fullstack'
  return arenaHtml(category, [{ model: a, score: dev ? 1200 : 1500, input: 2, output: 6 }, { model: b, score: dev ? 1500 : 1200, input: 1, output: 3 }])
}
module.exports = { arenaHtml, categories, allocationFixture }
